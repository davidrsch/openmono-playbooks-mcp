/**
 * OpenMono Playbooks TypeScript Type Definitions
 *
 * Mirrors the OpenMonoAgent.ai playbook schema for the MCP server.
 * All types correspond to fields in the PLAYBOOK.md YAML frontmatter.
 */

// ─── Parameter Types ───────────────────────────────────────────

export type ParameterType = "String" | "Number" | "Boolean" | "Array";

export interface PlaybookParameter {
  type: ParameterType;
  required: boolean;
  default?: unknown;
  hint?: string;
  /** Allowed values for String parameters */
  enum?: string[];
  /** Minimum value for Number parameters */
  min?: number;
  /** Maximum value for Number parameters */
  max?: number;
}

// ─── Trigger Types ─────────────────────────────────────────────

export type TriggerMode = "manual" | "auto" | "both";

// ─── Context Modes ─────────────────────────────────────────────

export type ContextMode = "Full" | "Selective" | "Fork";

// ─── Gate Types ────────────────────────────────────────────────

export type GateType = "None" | "Confirm" | "Review" | "Approve";

// ─── Step Types ──────────────────────────────────────────────

/**
 * A step in a playbook's execution DAG.
 * Steps are topologically sorted by their `requires` dependencies.
 */
export interface PlaybookStep {
  /** Unique identifier within the playbook (e.g., "01-analyze", "02-changelog") */
  id: string;
  /** Names of steps that must complete before this one */
  requires: string[];
  /** Path to an external Markdown file containing the step prompt */
  file?: string;
  /** Inline prompt text for the step */
  "inline-prompt"?: string;
  /** Shell script to run as a step validator */
  script?: string;
  /** Human-in-the-loop gate type */
  gate?: GateType;
  /** Named output key for state persistence */
  output?: string;
  /** Sub-agent name to execute this step under */
  agent?: string;
  /** Sub-playbook name to invoke for this step */
  playbook?: string;
  /** Whether automatic retry is enabled on failure */
  auto_retry?: boolean;
  /** Description shown in progress output */
  description?: string;
  /** Maximum time in seconds this step is allowed to run (0 = unlimited) */
  timeout?: number;
}

// ─── Constraint Types ──────────────────────────────────────────

/**
 * Constraints are safety guardrails injected into every step's context.
 * They can be defined inline or in external files.
 */
export interface PlaybookConstraint {
  /** Constraint description / rule */
  rule: string;
  /** Severity level */
  severity?: "error" | "warning";
  /** Optional justification for why this constraint exists */
  reason?: string;
}

// ─── Playbook Definition ──────────────────────────────────────

/**
 * Complete parsed PLAYBOOK.md structure.
 * The frontmatter is the YAML portion; the Markdown body is the system prompt.
 */
export interface PlaybookDefinition {
  /** Unique playbook identifier */
  name: string;
  /** Semantic version string (e.g., "1.0.0") */
  version: string;
  /** One-line description shown in listings */
  description: string;
  /** How the playbook is invoked */
  trigger: TriggerMode;
  /** Glob/wildcard patterns for auto-trigger matching */
  "trigger-patterns"?: string[];
  /** Whether the user can invoke this directly */
  "user-invocable"?: boolean;
  /** Shown in help text */
  "argument-hint"?: string;
  /** Typed input parameters */
  parameters?: Record<string, PlaybookParameter>;
  /** Execution steps (DAG, topologically sorted) */
  steps?: PlaybookStep[];
  /** Safety constraints injected into context */
  constraints?: PlaybookConstraint[];
  /** Tools the agent is allowed to use */
  "allowed-tools"?: string[];
  /** Context mode for LLM calls */
  "context-mode"?: ContextMode;
  /** Categorization tags */
  tags?: string[];
  /** Names of playbooks this one depends on */
  "depends-on"?: string[];
  /** The Markdown body after the YAML frontmatter */
  body: string;
  /** Filesystem path where this playbook was loaded from */
  _path: string;
  /** Directory containing this playbook */
  _dir: string;
}

// ─── Runtime State ─────────────────────────────────────────────

export interface PlaybookRunState {
  /** Unique run ID */
  runId: string;
  /** Playbook name being executed */
  playbookName: string;
  /** Playbook version */
  playbookVersion: string;
  /** When execution started (ISO 8601) */
  startedAt: string;
  /** When execution finished (ISO 8601, null if running) */
  finishedAt: string | null;
  /** Current status */
  status: "running" | "paused" | "completed" | "failed";
  /** Index of the current/most-recently-completed step (0-based) */
  currentStepIndex: number;
  /** Total number of steps */
  totalSteps: number;
  /** Parameters supplied at invocation */
  params: Record<string, unknown>;
  /** Named outputs from completed steps */
  state: Record<string, string>;
  /** Completion status of each step */
  stepResults: StepResult[];
  /** Error message if status is "failed" */
  error?: string;
}

export interface StepResult {
  stepId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

// ─── MCP Tool Input Types ─────────────────────────────────────

export interface ListPlaybooksInput {
  /** Filter by tag */
  tag?: string;
}

export interface RunPlaybookInput {
  /** Playbook name to execute */
  name: string;
  /** Typed parameters */
  params?: Record<string, unknown>;
}

export interface ResumePlaybookInput {
  /** Run ID to resume */
  runId: string;
}

export interface GetPlaybookStateInput {
  /** Run ID to inspect */
  runId: string;
}

export interface ValidatePlaybookInput {
  /** Playbook name to validate */
  name: string;
  /** Optional: validate with specific parameters */
  params?: Record<string, unknown>;
}

// ─── Discovery ─────────────────────────────────────────────────

export interface PlaybookSummary {
  name: string;
  version: string;
  description: string;
  trigger: TriggerMode;
  tags?: string[];
  parameters?: Record<string, PlaybookParameter>;
  argumentHint?: string;
}