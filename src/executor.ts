/**
 * Playbook Executor
 *
 * Manages the lifecycle of a playbook run: parameter validation,
 * step execution with topological ordering, gate handling,
 * template resolution, checkpoint persistence, and resume.
 *
 * Mirrors PlaybookExecutor.cs from OpenMonoAgent.ai but adapted
 * for MCP — the LLM callbacks are handled by the MCP client,
 * while this module manages state and produces the prompt context
 * the MCP server sends back to the agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PlaybookStep, PlaybookRunState, PlaybookSummary, StepResult } from "./types.js";
import { loadPlaybook, discoverPlaybooks, validatePlaybook } from "./loader.js";
import {
  resolveTemplate,
  resolvePlaybookBody,
  formatConstraints,
  type TemplateContext,
} from "./template.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────

const STATE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  ".openmono",
  "state",
);

const STATE_FILE_PREFIX = "playbook-run-";

/** Maximum recursion depth for restore-and-retry loops */
const MAX_RESTORE_DEPTH = 3;

// ─── Active Runs ─────────────────────────────────────────────

/** In-memory cache of active runs — guarded by an async mutex */
const activeRuns = new Map<string, PlaybookRunState>();

/** Maximum number of runs to keep in memory before evicting the oldest completed/failed ones */
const MAX_ACTIVE_RUNS = parseInt(process.env.MAX_ACTIVE_RUNS ?? "1000", 10);

/**
 * Async mutex using a promise queue.
 * Provides serialized access to the activeRuns map, safe for async interleaving
 * if I/O is introduced within locked sections in the future.
 * Supports re-entrant acquisition by the same async context (used by
 * checkpoint restore logic that may recurse into the same function).
 */
class AsyncMutex {
  private locked = false;
  private queue: (() => void)[] = [];
  private reentrantDepth = 0;

  async acquire(): Promise<void> {
    // Re-entrant: if already locked by this async execution context, bump depth
    if (this.locked && this.reentrantDepth > 0) {
      this.reentrantDepth++;
      return;
    }
    if (!this.locked) {
      this.locked = true;
      this.reentrantDepth = 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.reentrantDepth = 1;
        resolve();
      });
    });
  }

  release(): void {
    this.reentrantDepth--;
    if (this.reentrantDepth > 0) return;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

const runMutex = new AsyncMutex();

async function withMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  await runMutex.acquire();
  try {
    return await fn();
  } finally {
    runMutex.release();
  }
}

/**
 * Evict the oldest completed or failed runs from memory if the cache
 * exceeds MAX_ACTIVE_RUNS. Completed/failed runs are always persisted
 * to disk, so eviction is safe.
 */
function evictIfNeeded(): void {
  if (activeRuns.size <= MAX_ACTIVE_RUNS) return;

  const excess = activeRuns.size - MAX_ACTIVE_RUNS;

  // Prefer evicting completed/failed runs first (oldest finishedAt)
  const evictCandidates = Array.from(activeRuns.entries())
    .filter(([, r]) => r.status === "completed" || r.status === "failed")
    .sort((a, b) => {
      const aTime = a[1].finishedAt ?? a[1].startedAt;
      const bTime = b[1].finishedAt ?? b[1].startedAt;
      return aTime.localeCompare(bTime);
    });

  for (let i = 0; i < Math.min(excess, evictCandidates.length); i++) {
    activeRuns.delete(evictCandidates[i][0]);
    logger.debug("executor", `Evicted completed/failed run from memory`, {
      runId: evictCandidates[i][0],
    });
  }

  // If still over limit, evict oldest in-progress/paused runs
  if (activeRuns.size > MAX_ACTIVE_RUNS) {
    const remaining = Array.from(activeRuns.entries())
      .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
    const stillExcess = activeRuns.size - MAX_ACTIVE_RUNS;
    for (let i = 0; i < stillExcess; i++) {
      activeRuns.delete(remaining[i][0]);
      logger.warn("executor", `Evicted in-progress run from memory (over capacity)`, {
        runId: remaining[i][0],
      });
    }
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get a summary of all discovered playbooks.
 */
export function listPlaybooks(tag?: string): PlaybookSummary[] {
  let all = discoverPlaybooks();
  if (tag) {
    all = all.filter((p) => p.tags?.includes(tag));
  }
  return all.map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    trigger: p.trigger,
    tags: p.tags,
    parameters: p.parameters,
    argumentHint: p["argument-hint"],
  }));
}

/**
 * Validate a playbook's syntax, parameters, and step structure.
 * Also flags unknown parameters provided by the caller.
 */
export function runValidate(
  name: string,
  params?: Record<string, unknown>,
): {
  valid: boolean;
  issues: { field: string; message: string; severity: string }[];
  paramErrors?: string[];
} {
  const pb = loadPlaybook(name);
  if (!pb) {
    return {
      valid: false,
      issues: [{ field: "name", message: `Playbook '${name}' not found`, severity: "error" }],
    };
  }

  const issues = validatePlaybook(pb);

  // Validate parameters if provided
  const paramErrors: string[] = [];
  if (params && pb.parameters) {
    // Detect unknown parameters
    for (const key of Object.keys(params)) {
      if (!(key in pb.parameters)) {
        paramErrors.push(`Unknown parameter: '${key}' (not defined in playbook)`);
      }
    }

    for (const [key, paramDef] of Object.entries(pb.parameters)) {
      if (paramDef.required && !(key in params)) {
        paramErrors.push(`Missing required parameter: ${key}`);
      }
      if (key in params) {
        const val = coerceParamValue(key, params[key], paramDef);
        const err = validateParamValue(key, val, paramDef);
        if (err) paramErrors.push(err);
      }
    }
  }

  return {
    valid: issues.length === 0 && paramErrors.length === 0,
    issues: issues.map((i) => ({ ...i })),
    paramErrors: paramErrors.length > 0 ? paramErrors : undefined,
  };
}

/**
 * Initialize a new playbook run.
 * Validates parameters, creates state, persists a checkpoint.
 */
export async function startRun(
  playbookName: string,
  params: Record<string, unknown> = {},
): Promise<{ run: PlaybookRunState; error?: string }> {
  const pb = loadPlaybook(playbookName);
  if (!pb) {
    return { run: createEmptyRun("", ""), error: "Playbook not found" };
  }

  // Detect unknown parameters
  if (pb.parameters) {
    for (const key of Object.keys(params)) {
      if (!(key in pb.parameters)) {
        return {
          run: createEmptyRun("", ""),
          error: `Unknown parameter: '${key}' (not defined in playbook '${playbookName}')`,
        };
      }
    }
  }

  // Validate parameters
  if (pb.parameters) {
    for (const [key, paramDef] of Object.entries(pb.parameters)) {
      if (paramDef.required && !(key in params)) {
        if (paramDef.default !== undefined) {
          params[key] = paramDef.default;
        } else {
          return {
            run: createEmptyRun("", ""),
            error: `Missing required parameter: '${key}' (${paramDef.hint ?? paramDef.type})`,
          };
        }
      }
      if (key in params) {
        const coerced = coerceParamValue(key, params[key], paramDef);
        const err = validateParamValue(key, coerced, paramDef);
        if (err) return { run: createEmptyRun("", ""), error: err };
        params[key] = coerced;
      }
    }
  }

  // Fill in defaults for optional parameters that weren't provided
  if (pb.parameters) {
    for (const [key, paramDef] of Object.entries(pb.parameters)) {
      if (!(key in params) && paramDef.default !== undefined) {
        params[key] = paramDef.default;
      }
    }
  }

  const runId = randomUUID();
  const steps = pb.steps ?? [];
  const run: PlaybookRunState = {
    runId,
    playbookName: pb.name,
    playbookVersion: pb.version,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "in_progress",
    currentStepIndex: 0,
    totalSteps: steps.length,
    params,
    state: {},
    stepResults: steps.map((s) => ({
      stepId: s.id,
      status: "pending",
    })),
  };

  await runMutex.acquire();
  try {
    activeRuns.set(runId, run);
    persistRun(run);
    evictIfNeeded();
  } finally {
    runMutex.release();
  }
  logger.info("executor", `Started playbook run: ${playbookName}`, { runId, playbookName });

  return { run };
}

/**
 * Get the context for the current step.
 * This is what the MCP server returns to the agent so it knows what to do next.
 */
export function getCurrentStepContext(run: PlaybookRunState):
  | {
      step: PlaybookStep;
      stepIndex: number;
      systemPrompt: string;
      resolvedPrompt: string;
      gate: PlaybookStep["gate"];
      allowedTools: string[];
    }
  | undefined {
  const pb = loadPlaybook(run.playbookName);
  if (!pb) return undefined;

  const steps = pb.steps ?? [];
  if (run.currentStepIndex >= steps.length) return undefined;

  const step = steps[run.currentStepIndex];

  // Build template context
  const ctx: TemplateContext = {
    params: run.params,
    state: run.state,
    constraints: pb.constraints ? formatConstraints(pb.constraints) : "",
    baseDir: pb._dir,
  };

  // Resolve the playbook body as system prompt
  const contextMode = pb["context-mode"] ?? "Full";

  let systemPrompt: string;
  switch (contextMode) {
    case "Selective":
      // Only return the step prompt, no system prompt body
      systemPrompt = `[Selective context mode — only the step prompt is shown]`;
      break;
    case "Fork":
      // Return system prompt with fork hint for sub-agent delegation
      systemPrompt =
        resolvePlaybookBody(pb.body, ctx) +
        "\n\n[Fork context mode — you may spawn sub-agents for this step]";
      break;
    case "Full":
    default:
      systemPrompt = resolvePlaybookBody(pb.body, ctx);
      break;
  }

  // Resolve the step prompt
  let stepPrompt = "";
  if (step.file) {
    const filePath = path.isAbsolute(step.file) ? step.file : path.resolve(pb._dir, step.file);
    if (fs.existsSync(filePath)) {
      stepPrompt = fs.readFileSync(filePath, "utf-8");
    }
  } else if (step["inline-prompt"]) {
    stepPrompt = step["inline-prompt"];
  } else if (step.playbook) {
    stepPrompt = `Execute the sub-playbook: ${step.playbook}\n\nParameters: ${JSON.stringify(run.params, null, 2)}`;
  }

  const resolvedPrompt = resolveTemplate(stepPrompt, ctx);

  return {
    step,
    stepIndex: run.currentStepIndex,
    systemPrompt,
    resolvedPrompt,
    gate: step.gate,
    allowedTools: pb["allowed-tools"] ?? ["*"],
  };
}

/**
 * Mark the current step as completed and advance.
 * Persists state for checkpoint/resume support.
 */
export async function completeCurrentStep(
  runId: string,
  output?: string,
  error?: string,
  _depth = 0,
): Promise<
  | { run: PlaybookRunState; nextStepContext: ReturnType<typeof getCurrentStepContext> }
  | { error: string }
> {
  return withMutex(async () => {
    const run = activeRuns.get(runId);
    if (!run) {
      // Guard against infinite restore loops
      if (_depth >= MAX_RESTORE_DEPTH) {
        return { error: `Run '${runId}' not found (max restore depth exceeded)` };
      }
      const persisted = loadPersistedRun(runId);
      if (!persisted) return { error: `Run '${runId}' not found` };
      // Restore from persistence
      activeRuns.set(runId, persisted);
      evictIfNeeded();
      return await completeCurrentStep(runId, output, error, _depth + 1);
    }

    if (run.currentStepIndex >= run.stepResults.length) {
      return { error: "No more steps in run" };
    }

    const pb = loadPlaybook(run.playbookName);
    if (!pb) return { error: `Playbook '${run.playbookName}' not found` };

    const stepResult = run.stepResults[run.currentStepIndex];
    const step = pb.steps?.[run.currentStepIndex];

    // ── Gate check ──
    // If the current step has a gate and it hasn't been acknowledged,
    // pause the run instead of completing the step.
    if (step?.gate && !error) {
      if (!run.gateStatus || !run.gateStatus.acknowledged) {
        run.status = "paused";
        run.gateStatus = {
          type: step.gate,
          stepId: step.id,
          acknowledged: false,
        };
        persistRun(run);
        logger.info("executor", `Run paused awaiting gate acknowledgment`, {
          runId,
          stepId: step.id,
          gateType: step.gate,
        });
        // Return the gate context so the agent knows to acknowledge
        const gateCtx = getCurrentStepContext(run);
        return { run, nextStepContext: gateCtx };
      }
      // Gate was acknowledged — clear it and proceed
      run.gateStatus = undefined;
      run.status = "in_progress";
    }

    if (error) {
      // ── Auto-retry ──
      if (step?.auto_retry) {
        const retryCount = (stepResult as StepResult & { retryCount?: number }).retryCount ?? 0;
        const maxRetries = 3;
        if (retryCount < maxRetries) {
          (stepResult as StepResult & { retryCount: number }).retryCount = retryCount + 1;
          stepResult.status = "running";
          stepResult.startedAt = new Date().toISOString();
          persistRun(run);
          logger.info("executor", `Step auto-retry ${retryCount + 1}/${maxRetries}: ${step?.id}`, {
            runId,
            stepId: step?.id,
            retryCount: retryCount + 1,
          });
          const retryCtx = getCurrentStepContext(run);
          return { run, nextStepContext: retryCtx };
        }
        // Max retries exceeded — fall through to failure
        stepResult.error = `Max retries (${maxRetries}) exceeded. Last error: ${error}`;
      } else {
        stepResult.error = error;
      }

      stepResult.status = "failed";
      stepResult.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.error = stepResult.error;
      run.finishedAt = new Date().toISOString();
      persistRun(run);
      logger.info("executor", `Step failed: ${step?.id}`, { runId, stepId: step?.id, error });
      return { run, nextStepContext: undefined };
    }

    // ── Timeout check ──
    if (step?.timeout && step.timeout > 0) {
      const stepResult2 = run.stepResults[run.currentStepIndex];
      if (stepResult2.startedAt) {
        const elapsed = Date.now() - new Date(stepResult2.startedAt).getTime();
        if (elapsed > step.timeout * 1000) {
          stepResult2.status = "failed";
          stepResult2.error = `Step timed out after ${step.timeout}s`;
          stepResult2.finishedAt = new Date().toISOString();
          run.status = "failed";
          run.error = stepResult2.error;
          run.finishedAt = new Date().toISOString();
          persistRun(run);
          logger.info("executor", `Step timed out: ${step.id}`, {
            runId,
            stepId: step.id,
            timeout: step.timeout,
            elapsed,
          });
          return { run, nextStepContext: undefined };
        }
      }
    }

    stepResult.status = "completed";
    stepResult.output = output;
    stepResult.finishedAt = new Date().toISOString();

    // Store named output
    if (step?.output && output !== undefined) {
      run.state[step.output] = output;
    }

    run.currentStepIndex++;

    // Check if done
    if (run.currentStepIndex >= run.totalSteps) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      persistRun(run);
      logger.info("executor", `Playbook run completed: ${run.playbookName}`, {
        runId,
        playbookName: run.playbookName,
        totalSteps: run.totalSteps,
      });
      return { run, nextStepContext: undefined };
    }

    // Advance to next step
    run.stepResults[run.currentStepIndex] = {
      ...run.stepResults[run.currentStepIndex],
      status: "running",
      startedAt: new Date().toISOString(),
    };

    persistRun(run);

    const nextCtx = getCurrentStepContext(run);
    return { run, nextStepContext: nextCtx };
  });
}

/**
 * Mark the current step as skipped.
 */
export async function skipCurrentStep(
  runId: string,
  _depth = 0,
): Promise<
  | { run: PlaybookRunState; nextStepContext: ReturnType<typeof getCurrentStepContext> }
  | { error: string }
> {
  return withMutex(async () => {
    const run = activeRuns.get(runId);
    if (!run) {
      if (_depth >= MAX_RESTORE_DEPTH) {
        return { error: `Run '${runId}' not found (max restore depth exceeded)` };
      }
      const persisted = loadPersistedRun(runId);
      if (!persisted) return { error: `Run '${runId}' not found` };
      activeRuns.set(runId, persisted);
      evictIfNeeded();
      return await skipCurrentStep(runId, _depth + 1);
    }

    if (run.currentStepIndex >= run.stepResults.length) {
      return { error: "No more steps in run" };
    }

    const stepResult = run.stepResults[run.currentStepIndex];
    stepResult.status = "skipped";
    stepResult.finishedAt = new Date().toISOString();
    run.currentStepIndex++;

    if (run.currentStepIndex >= run.totalSteps) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      persistRun(run);
      return { run, nextStepContext: undefined };
    }

    run.stepResults[run.currentStepIndex] = {
      ...run.stepResults[run.currentStepIndex],
      status: "running",
      startedAt: new Date().toISOString(),
    };

    persistRun(run);

    const nextCtx = getCurrentStepContext(run);
    return { run, nextStepContext: nextCtx };
  });
}

/**
 * Resume an interrupted run from its last checkpoint.
 */
export async function resumeRun(
  runId: string,
): Promise<
  | { run: PlaybookRunState; stepContext: ReturnType<typeof getCurrentStepContext> }
  | { error: string }
> {
  return withMutex(async () => {
    let run = activeRuns.get(runId);
    if (!run) {
      const persisted = loadPersistedRun(runId);
      if (!persisted) return { error: `Run '${runId}' not found` };
      run = persisted;
      activeRuns.set(runId, run);
      evictIfNeeded();
    }

    if (run.status === "completed") {
      // Already finished — return the run with no next step context
      return { run, stepContext: undefined };
    }

    run.status = "in_progress";

    // Set current step as running if it's pending
    if (
      run.currentStepIndex < run.stepResults.length &&
      run.stepResults[run.currentStepIndex].status === "pending"
    ) {
      run.stepResults[run.currentStepIndex].status = "running";
      run.stepResults[run.currentStepIndex].startedAt = new Date().toISOString();
    }

    persistRun(run);
    logger.info("executor", `Resumed playbook run: ${run.playbookName}`, {
      runId,
      playbookName: run.playbookName,
      currentStepIndex: run.currentStepIndex,
    });

    const stepContext = getCurrentStepContext(run);
    return { run, stepContext };
  });
}

/**
 * Get the full state of a run (active or persisted).
 */
export function getRunState(runId: string): PlaybookRunState | { error: string } {
  const run = activeRuns.get(runId);
  if (run) return run;

  const persisted = loadPersistedRun(runId);
  if (persisted) return persisted;

  return { error: `Run '${runId}' not found` };
}

/**
 * Clear all in-memory active runs. Used by tests for clean state between cases.
 * This does NOT delete persisted checkpoint files on disk.
 */
export function clearActiveRuns(): void {
  activeRuns.clear();
}

/**
 * Acknowledge a human-in-the-loop gate for the current paused step.
 * After acknowledgment, the step is marked completed and the run advances.
 */
export async function acknowledgeGate(
  runId: string,
  output?: string,
): Promise<
  | { run: PlaybookRunState; nextStepContext: ReturnType<typeof getCurrentStepContext> }
  | { error: string }
> {
  return withMutex(async () => {
    const run = activeRuns.get(runId);
    if (!run) {
      const persisted = loadPersistedRun(runId);
      if (!persisted) return { error: `Run '${runId}' not found` };
      activeRuns.set(runId, persisted);
      evictIfNeeded();
      return await acknowledgeGate(runId, output);
    }

    if (!run.gateStatus) {
      return { error: `Run '${runId}' is not awaiting a gate acknowledgment` };
    }

    if (run.gateStatus.acknowledged) {
      return { error: `Gate for run '${runId}' has already been acknowledged` };
    }

    // Mark gate as acknowledged
    run.gateStatus.acknowledged = true;
    run.status = "in_progress";
    persistRun(run);
    logger.info("executor", `Gate acknowledged for run`, {
      runId,
      stepId: run.gateStatus.stepId,
      gateType: run.gateStatus.type,
    });

    // Now complete the step
    const result = await completeCurrentStep(runId, output);
    return result;
  });
}

// ─── Parameter Coercion ──────────────────────────────────────

/**
 * Coerce a raw input value to the expected parameter type.
 * This is a best-effort coercion for CLI/HTTP inputs where everything
 * is a string. It does NOT change the original params — callers should
 * use the returned coerced value for validation & storage.
 */
function coerceParamValue(key: string, value: unknown, def: { type: string }): unknown {
  if (value === undefined || value === null) return value;

  switch (def.type) {
    case "Number": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const n = Number(value);
        if (!isNaN(n)) return n;
      }
      return value; // let validation fail
    }
    case "Boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
      }
      return value; // let validation fail
    }
    case "Array": {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        return value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      return value; // let validation fail
    }
    default:
      return value;
  }
}

// ─── Parameter Validation ────────────────────────────────────

function validateParamValue(
  key: string,
  value: unknown,
  def: { type: string; required: boolean; enum?: string[]; min?: number; max?: number },
): string | null {
  switch (def.type) {
    case "String": {
      if (typeof value !== "string") {
        return `Parameter '${key}' expected String, got ${typeof value}`;
      }
      if (def.enum && !def.enum.includes(value)) {
        return `Parameter '${key}' must be one of: ${def.enum.join(", ")}`;
      }
      return null;
    }
    case "Number": {
      // Strict check: only accept actual numbers, not strings that happen to parse
      if (typeof value !== "number" || isNaN(value)) {
        return `Parameter '${key}' expected Number, got ${typeof value}`;
      }
      if (def.min !== undefined && value < def.min) {
        return `Parameter '${key}' minimum is ${def.min}`;
      }
      if (def.max !== undefined && value > def.max) {
        return `Parameter '${key}' maximum is ${def.max}`;
      }
      return null;
    }
    case "Boolean": {
      if (typeof value !== "boolean") {
        return `Parameter '${key}' expected Boolean, got ${typeof value}`;
      }
      return null;
    }
    case "Array": {
      if (!Array.isArray(value)) {
        return `Parameter '${key}' expected Array, got ${typeof value}`;
      }
      return null;
    }
    default:
      return null;
  }
}

// ─── Persistence (Checkpoint/Resume) ─────────────────────────

function persistRun(run: PlaybookRunState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const filePath = path.join(STATE_DIR, `${STATE_FILE_PREFIX}${run.runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");
  } catch (err) {
    logger.error("executor", `Failed to persist run ${run.runId}`, {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function loadPersistedRun(runId: string): PlaybookRunState | null {
  try {
    const filePath = path.join(STATE_DIR, `${STATE_FILE_PREFIX}${runId}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PlaybookRunState;
  } catch {
    logger.warn("executor", `Failed to load persisted run: ${runId}`, { runId });
    return null;
  }
}

function createEmptyRun(name: string, version: string): PlaybookRunState {
  return {
    runId: "",
    playbookName: name,
    playbookVersion: version,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "failed",
    currentStepIndex: 0,
    totalSteps: 0,
    params: {},
    state: {},
    stepResults: [],
    error: "",
  };
}
