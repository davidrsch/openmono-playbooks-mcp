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
import { loadPlaybook, discoverPlaybooks, validatePlaybook } from "./loader.js";
import { resolveTemplate, resolvePlaybookBody, formatConstraints, } from "./template.js";
import { logger } from "./logger.js";
// ─── Constants ────────────────────────────────────────────────
const STATE_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".openmono", "state");
const STATE_FILE_PREFIX = "playbook-run-";
/** Maximum recursion depth for restore-and-retry loops */
const MAX_RESTORE_DEPTH = 3;
// ─── Active Runs ─────────────────────────────────────────────
/** In-memory cache of active runs — guarded by a simple mutex */
const activeRuns = new Map();
let activeRunsLock = false;
function withMutex(fn) {
    // Simple spinlock guard for in-process concurrent access
    // In a single-threaded Node.js environment this is primarily a safety measure
    // against re-entrant calls (e.g. from recursive restore logic).
    if (activeRunsLock) {
        logger.warn("executor", "Mutex contention on activeRuns", {});
    }
    activeRunsLock = true;
    try {
        return fn();
    }
    finally {
        activeRunsLock = false;
    }
}
// ─── Public API ──────────────────────────────────────────────
/**
 * Get a summary of all discovered playbooks.
 */
export function listPlaybooks(tag) {
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
export function runValidate(name, params) {
    const pb = loadPlaybook(name);
    if (!pb) {
        return {
            valid: false,
            issues: [{ field: "name", message: `Playbook '${name}' not found`, severity: "error" }],
        };
    }
    const issues = validatePlaybook(pb);
    // Validate parameters if provided
    const paramErrors = [];
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
                const val = params[key];
                const err = validateParamValue(key, val, paramDef);
                if (err)
                    paramErrors.push(err);
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
export function startRun(playbookName, params = {}) {
    const pb = loadPlaybook(playbookName);
    if (!pb) {
        return { run: createEmptyRun("", ""), error: `Playbook '${playbookName}' not found` };
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
                }
                else {
                    return {
                        run: createEmptyRun("", ""),
                        error: `Missing required parameter: '${key}' (${paramDef.hint ?? paramDef.type})`,
                    };
                }
            }
            if (key in params) {
                const val = params[key];
                const err = validateParamValue(key, val, paramDef);
                if (err)
                    return { run: createEmptyRun("", ""), error: err };
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
    const run = {
        runId,
        playbookName: pb.name,
        playbookVersion: pb.version,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        currentStepIndex: 0,
        totalSteps: steps.length,
        params,
        state: {},
        stepResults: steps.map((s) => ({
            stepId: s.id,
            status: "pending",
        })),
    };
    activeRuns.set(runId, run);
    persistRun(run);
    logger.info("executor", `Started playbook run: ${playbookName}`, { runId });
    return { run };
}
/**
 * Get the context for the current step.
 * This is what the MCP server returns to the agent so it knows what to do next.
 */
export function getCurrentStepContext(run) {
    const pb = loadPlaybook(run.playbookName);
    if (!pb)
        return null;
    const steps = pb.steps ?? [];
    if (run.currentStepIndex >= steps.length)
        return null;
    const step = steps[run.currentStepIndex];
    // Build template context
    const ctx = {
        params: run.params,
        state: run.state,
        constraints: pb.constraints ? formatConstraints(pb.constraints) : "",
        baseDir: pb._dir,
    };
    // Resolve the playbook body as system prompt
    const systemPrompt = resolvePlaybookBody(pb.body, ctx);
    // Resolve the step prompt
    let stepPrompt = "";
    if (step.file) {
        const filePath = path.isAbsolute(step.file) ? step.file : path.resolve(pb._dir, step.file);
        if (fs.existsSync(filePath)) {
            stepPrompt = fs.readFileSync(filePath, "utf-8");
        }
    }
    else if (step["inline-prompt"]) {
        stepPrompt = step["inline-prompt"];
    }
    else if (step.playbook) {
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
export function completeCurrentStep(runId, output, error, _depth = 0) {
    return withMutex(() => {
        const run = activeRuns.get(runId);
        if (!run) {
            // Guard against infinite restore loops
            if (_depth >= MAX_RESTORE_DEPTH) {
                return { error: `Run '${runId}' not found (max restore depth exceeded)` };
            }
            const persisted = loadPersistedRun(runId);
            if (!persisted)
                return { error: `Run '${runId}' not found` };
            // Restore from persistence
            activeRuns.set(runId, persisted);
            return completeCurrentStep(runId, output, error, _depth + 1);
        }
        if (run.currentStepIndex >= run.stepResults.length) {
            return { error: "No more steps in run" };
        }
        const pb = loadPlaybook(run.playbookName);
        if (!pb)
            return { error: `Playbook '${run.playbookName}' not found` };
        const stepResult = run.stepResults[run.currentStepIndex];
        const step = pb.steps?.[run.currentStepIndex];
        if (error) {
            stepResult.status = "failed";
            stepResult.error = error;
            stepResult.finishedAt = new Date().toISOString();
            run.status = "failed";
            run.error = error;
            run.finishedAt = new Date().toISOString();
            persistRun(run);
            logger.info("executor", `Step failed: ${step?.id}`, { runId, error });
            return { run, nextStepContext: null };
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
            logger.info("executor", `Playbook run completed: ${run.playbookName}`, { runId });
            return { run, nextStepContext: null };
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
export function skipCurrentStep(runId, _depth = 0) {
    return withMutex(() => {
        const run = activeRuns.get(runId);
        if (!run) {
            if (_depth >= MAX_RESTORE_DEPTH) {
                return { error: `Run '${runId}' not found (max restore depth exceeded)` };
            }
            const persisted = loadPersistedRun(runId);
            if (!persisted)
                return { error: `Run '${runId}' not found` };
            activeRuns.set(runId, persisted);
            return skipCurrentStep(runId, _depth + 1);
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
            return { run, nextStepContext: null };
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
export function resumeRun(runId) {
    return withMutex(() => {
        let run = activeRuns.get(runId);
        if (!run) {
            const persisted = loadPersistedRun(runId);
            if (!persisted)
                return { error: `Run '${runId}' not found` };
            run = persisted;
            activeRuns.set(runId, run);
        }
        if (run.status === "completed") {
            return { error: `Run '${runId}' is already completed` };
        }
        run.status = "running";
        // Set current step as running if it's pending
        if (run.currentStepIndex < run.stepResults.length &&
            run.stepResults[run.currentStepIndex].status === "pending") {
            run.stepResults[run.currentStepIndex].status = "running";
            run.stepResults[run.currentStepIndex].startedAt = new Date().toISOString();
        }
        persistRun(run);
        logger.info("executor", `Resumed playbook run: ${run.playbookName}`, { runId });
        const stepContext = getCurrentStepContext(run);
        return { run, stepContext };
    });
}
/**
 * Get the full state of a run (active or persisted).
 */
export function getRunState(runId) {
    const run = activeRuns.get(runId);
    if (run)
        return run;
    const persisted = loadPersistedRun(runId);
    if (persisted)
        return persisted;
    return { error: `Run '${runId}' not found` };
}
// ─── Parameter Validation ────────────────────────────────────
function validateParamValue(key, value, def) {
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
function persistRun(run) {
    try {
        if (!fs.existsSync(STATE_DIR)) {
            fs.mkdirSync(STATE_DIR, { recursive: true });
        }
        const filePath = path.join(STATE_DIR, `${STATE_FILE_PREFIX}${run.runId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");
    }
    catch (err) {
        logger.error("executor", `Failed to persist run ${run.runId}`, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
function loadPersistedRun(runId) {
    try {
        const filePath = path.join(STATE_DIR, `${STATE_FILE_PREFIX}${runId}.json`);
        if (!fs.existsSync(filePath))
            return null;
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        logger.warn("executor", `Failed to load persisted run: ${runId}`, {});
        return null;
    }
}
function createEmptyRun(name, version) {
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
//# sourceMappingURL=executor.js.map