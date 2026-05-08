/**
 * Standalone unit tests for the errors module.
 *
 * Covers:
 *  - All ErrorCode enum values
 *  - makeError construction
 *  - McpErrorResult shape
 *  - Error codes are unique
 */

import { describe, it, expect } from "vitest";
import { ErrorCode, makeError, type McpErrorResult } from "../errors.js";

describe("ErrorCode enum", () => {
  it("has all expected error codes", () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toContain("PLAYBOOK_NOT_FOUND");
    expect(codes).toContain("PLAYBOOK_PARSE_ERROR");
    expect(codes).toContain("PLAYBOOK_VALIDATION_ERROR");
    expect(codes).toContain("MISSING_REQUIRED_PARAM");
    expect(codes).toContain("UNKNOWN_PARAM");
    expect(codes).toContain("PARAM_TYPE_ERROR");
    expect(codes).toContain("RUN_NOT_FOUND");
    expect(codes).toContain("RUN_ALREADY_COMPLETED");
    expect(codes).toContain("RUN_FAILED");
    expect(codes).toContain("NO_MORE_STEPS");
    expect(codes).toContain("MAX_RESTORE_DEPTH");
    expect(codes).toContain("INPUT_TOO_LARGE");
    expect(codes).toContain("RATE_LIMIT_EXCEEDED");
    expect(codes).toContain("INTERNAL_ERROR");
    expect(codes).toContain("SUB_PLAYBOOK_NOT_FOUND");
  });

  it("has no duplicate error code values", () => {
    const codes = Object.values(ErrorCode);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe("makeError", () => {
  it("creates a structured error with code and message", () => {
    const err = makeError(ErrorCode.PLAYBOOK_NOT_FOUND, "Playbook 'test' not found");
    expect(err.error).toBe(true);
    expect(err.code).toBe("PLAYBOOK_NOT_FOUND");
    expect(err.message).toBe("Playbook 'test' not found");
    expect(err.details).toBeUndefined();
  });

  it("includes details when provided", () => {
    const err = makeError(ErrorCode.INPUT_TOO_LARGE, "Input too large", {
      size: 2_000_000,
      maxSize: 1_048_576,
    });
    expect(err.error).toBe(true);
    expect(err.code).toBe("INPUT_TOO_LARGE");
    expect(err.message).toBe("Input too large");
    expect(err.details).toEqual({ size: 2_000_000, maxSize: 1_048_576 });
  });

  it("produces machine-readable error codes", () => {
    const err = makeError(ErrorCode.RATE_LIMIT_EXCEEDED, "Slow down");
    // The code should be a string constant, not a numeric enum
    expect(typeof err.code).toBe("string");
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("has error: true flag", () => {
    const err = makeError(ErrorCode.INTERNAL_ERROR, "Something broke");
    expect(err.error).toBe(true);
  });
});

describe("McpErrorResult type", () => {
  it("satisfies McpErrorResult interface", () => {
    const err: McpErrorResult = {
      error: true,
      code: ErrorCode.RUN_NOT_FOUND,
      message: "Run 'abc' not found",
    };
    expect(err.error).toBe(true);
    expect(err.code).toBe(ErrorCode.RUN_NOT_FOUND);
  });

  it("supports optional details", () => {
    const err: McpErrorResult = {
      error: true,
      code: ErrorCode.PARAM_TYPE_ERROR,
      message: "Wrong type",
      details: { expected: "Number", got: "string" },
    };
    expect(err.details).toBeDefined();
    expect(err.details!.expected).toBe("Number");
  });
});
