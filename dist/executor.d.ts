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
import type { PlaybookStep, PlaybookRunState, PlaybookSummary } from "./types.js";
/**
 * Get a summary of all discovered playbooks.
 */
export declare function listPlaybooks(tag?: string): PlaybookSummary[];
/**
 * Validate a playbook's syntax, parameters, and step structure.
 */
export declare function runValidate(name: string, params?: Record<string, unknown>): {
    valid: boolean;
    issues: {
        field: string;
        message: string;
        severity: string;
    }[];
    paramErrors?: string[];
};
/**
 * Initialize a new playbook run.
 * Validates parameters, creates state, persists a checkpoint.
 */
export declare function startRun(playbookName: string, params?: Record<string, unknown>): {
    run: PlaybookRunState;
    error?: string;
};
/**
 * Get the context for the current step.
 * This is what the MCP server returns to the agent so it knows what to do next.
 */
export declare function getCurrentStepContext(run: PlaybookRunState): {
    step: PlaybookStep;
    stepIndex: number;
    systemPrompt: string;
    resolvedPrompt: string;
    gate: PlaybookStep["gate"];
    allowedTools: string[];
} | null;
/**
 * Mark the current step as completed and advance.
 * Persists state for checkpoint/resume support.
 */
export declare function completeCurrentStep(runId: string, output?: string, error?: string): {
    run: PlaybookRunState;
    nextStepContext: ReturnType<typeof getCurrentStepContext>;
} | {
    error: string;
};
/**
 * Mark the current step as skipped.
 */
export declare function skipCurrentStep(runId: string): {
    run: PlaybookRunState;
    nextStepContext: ReturnType<typeof getCurrentStepContext>;
} | {
    error: string;
};
/**
 * Resume an interrupted run from its last checkpoint.
 */
export declare function resumeRun(runId: string): {
    run: PlaybookRunState;
    stepContext: ReturnType<typeof getCurrentStepContext>;
} | {
    error: string;
};
/**
 * Get the full state of a run (active or persisted).
 */
export declare function getRunState(runId: string): PlaybookRunState | {
    error: string;
};
