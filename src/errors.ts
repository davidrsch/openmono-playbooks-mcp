/**
 * Typed Error Codes for the OpenMono Playbooks MCP Server.
 *
 * Provides structured, machine-readable error codes that MCP clients
 * can use for programmatic error handling, rather than parsing string messages.
 */

export enum ErrorCode {
  /** Playbook was not found in any search path */
  PLAYBOOK_NOT_FOUND = "PLAYBOOK_NOT_FOUND",
  /** Playbook YAML frontmatter is missing or malformed */
  PLAYBOOK_PARSE_ERROR = "PLAYBOOK_PARSE_ERROR",
  /** Playbook failed validation (missing fields, circular deps, etc.) */
  PLAYBOOK_VALIDATION_ERROR = "PLAYBOOK_VALIDATION_ERROR",
  /** A required parameter was not provided */
  MISSING_REQUIRED_PARAM = "MISSING_REQUIRED_PARAM",
  /** An unknown parameter was provided that the playbook does not define */
  UNKNOWN_PARAM = "UNKNOWN_PARAM",
  /** A parameter value failed type validation */
  PARAM_TYPE_ERROR = "PARAM_TYPE_ERROR",
  /** The run ID was not found (expired, never existed, or persistence lost) */
  RUN_NOT_FOUND = "RUN_NOT_FOUND",
  /** The run has already completed and cannot be modified */
  RUN_ALREADY_COMPLETED = "RUN_ALREADY_COMPLETED",
  /** The run is in a failed state and cannot be advanced */
  RUN_FAILED = "RUN_FAILED",
  /** No more steps exist in the run */
  NO_MORE_STEPS = "NO_MORE_STEPS",
  /** Restore depth exceeded (potential infinite loop) */
  MAX_RESTORE_DEPTH = "MAX_RESTORE_DEPTH",
  /** Input exceeded maximum allowed size */
  INPUT_TOO_LARGE = "INPUT_TOO_LARGE",
  /** An unexpected internal error occurred */
  INTERNAL_ERROR = "INTERNAL_ERROR",
  /** A sub-playbook was not found */
  SUB_PLAYBOOK_NOT_FOUND = "SUB_PLAYBOOK_NOT_FOUND",
  /** A gated step cannot be advanced until the gate is acknowledged */
  GATE_NOT_ACKNOWLEDGED = "GATE_NOT_ACKNOWLEDGED",
  /** A step exceeded its configured timeout */
  STEP_TIMED_OUT = "STEP_TIMED_OUT",
  /** Maximum auto-retry attempts exceeded */
  MAX_RETRIES_EXCEEDED = "MAX_RETRIES_EXCEEDED",
  /** Circular dependency detected in playbook depends-on chain */
  CIRCULAR_DEPENDENCY = "CIRCULAR_DEPENDENCY",
}

/**
 * Structured error returned by the MCP server.
 * Carries a machine-readable code, a human-readable message,
 * and optional metadata for debugging.
 */
export interface McpErrorResult {
  error: true;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): McpErrorResult {
  return { error: true, code, message, ...(details ? { details } : {}) };
}
