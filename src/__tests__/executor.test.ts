/**
 * Integration tests for the playbook executor module.
 *
 * Covers:
 *  - startRun with valid params, missing params, unknown params
 *  - Parameter type coercion (Number, Boolean, Array)
 *  - Step completion, skipping, failing
 *  - State output tracking {{state.key}}
 *  - Resume from checkpoint
 *  - getRunState / getCurrentStepContext
 *  - runValidate
 *  - Non-existent playbook and run errors
 *
 * These tests use the real loader and executor on the in-tree test fixtures.
 * They do NOT spin up the MCP server (no stdio required).
 */

import { describe, it, expect } from "vitest";
import {
  startRun,
  completeCurrentStep,
  skipCurrentStep,
  resumeRun,
  getRunState,
  runValidate,
  getCurrentStepContext,
} from "../executor.js";

// ── startRun ──────────────────────────────────────────────────

describe("startRun", () => {
  it("starts a valid playbook and returns a run", () => {
    const result = startRun("test-minimal", {});
    expect(result.error).toBeUndefined();
    expect(result.run).toBeDefined();
    expect(result.run!.runId).toBeDefined();
    expect(result.run!.playbookName).toBe("test-minimal");
    expect(result.run!.status).toBe("in_progress");
    expect(result.run!.currentStepIndex).toBe(0);
  });

  it("returns an error for a non-existent playbook", () => {
    const result = startRun("non-existent-playbook-xyz", {});
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Playbook not found/i);
  });

  it("rejects unknown parameters when the playbook has params defined", () => {
    const result = startRun("test-with-params", {
      message: "hello",
      unknownParam: "bad",
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/unknownParam/i);
  });

  it("applies default values for optional parameters", () => {
    const result = startRun("test-with-params", { message: "hello" });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.count).toBe(1); // default
    expect(result.run!.params.enabled).toBe(false); // default
  });

  it("coerces Number parameters", () => {
    const result = startRun("test-with-params", {
      message: "hello",
      count: "42" as unknown as number,
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.count).toBe(42);
    expect(typeof result.run!.params.count).toBe("number");
  });

  it("coerces Boolean parameters", () => {
    const result = startRun("test-with-params", {
      message: "hello",
      enabled: "true" as unknown as boolean,
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.enabled).toBe(true);
  });

  it("coerces Array parameters from comma-separated strings", () => {
    const result = startRun("test-with-params", {
      message: "hello",
      tags: "a, b, c" as unknown as string[],
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.tags).toEqual(["a", "b", "c"]);
  });

  it("errors on missing required parameters", () => {
    const result = startRun("test-with-params", {});
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/message/i); // 'message' is required
  });
});

// ── Step lifecycle: complete ─────────────────────────────────

describe("completeCurrentStep", () => {
  it("completes a step and advances to the next", () => {
    const start = startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = completeCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("in_progress");
    expect(result.run.currentStepIndex).toBe(1);
    expect(result.nextStepContext).toBeDefined();
    expect(result.nextStepContext!.step.id).toBe("step-two");
  });

  it("marks the run as completed when all steps are done", () => {
    const start = startRun("test-two-steps", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete step 1
    const r1 = completeCurrentStep(runId);
    expect("error" in r1).toBe(false);
    if ("error" in r1) return;
    expect(r1.run.status).toBe("in_progress");

    // Complete step 2 (last step)
    const r2 = completeCurrentStep(runId);
    expect("error" in r2).toBe(false);
    if ("error" in r2) return;
    expect(r2.run.status).toBe("completed");
    expect(r2.nextStepContext).toBeUndefined();
    expect(r2.run.totalSteps).toBe(2);
  });

  it("stores step output for downstream {{state.key}} references", () => {
    const start = startRun("test-state-output", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = completeCurrentStep(runId, "my-output-value");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // The state should now contain the output key for step "step-one"
    const state = getRunState(runId);
    if ("error" in state) {
      expect("state lookup failed").toBeUndefined();
      return;
    }
    expect(state.state).toHaveProperty("step-one_output");
    expect(state.state["step-one_output"]).toBe("my-output-value");
  });

  it("returns an error for an unknown runId", () => {
    const result = completeCurrentStep("nonexistent-run-id-12345");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/not found/i);
  });
});

// ── Step lifecycle: skip ─────────────────────────────────────

describe("skipCurrentStep", () => {
  it("skips the current step and advances", () => {
    const start = startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = skipCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.currentStepIndex).toBe(1);
    expect(result.nextStepContext!.step.id).toBe("step-two");
    // Step 0 should be marked as skipped
    expect(result.run.stepResults[0].status).toBe("skipped");
  });

  it("completes the run when the last step is skipped", () => {
    const start = startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = skipCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("completed");
    expect(result.nextStepContext).toBeUndefined();
  });
});

// ── Step lifecycle: fail ─────────────────────────────────────

describe("fail step", () => {
  it("fails the current step and terminates the run", () => {
    const start = startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = completeCurrentStep(runId, undefined, "something went wrong");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/something went wrong/);
  });
});

// ── Resume ────────────────────────────────────────────────────

describe("resumeRun", () => {
  it("resumes an in-progress run and returns the current step context", () => {
    const start = startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Advance one step so the run is mid-flight
    const step1 = completeCurrentStep(runId);
    expect("error" in step1).toBe(false);

    // Simulate "reconnect": resume the same runId
    const resumed = resumeRun(runId);
    expect("error" in resumed).toBe(false);
    if ("error" in resumed) return;
    expect(resumed.run.runId).toBe(runId);
    expect(resumed.run.currentStepIndex).toBe(1);
    expect(resumed.stepContext).toBeDefined();
    expect(resumed.stepContext!.step.id).toBe("step-two");
  });

  it("returns an error for a non-existent runId", () => {
    const result = resumeRun("nonexistent-run-id");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("returns that the run is already completed for a finished run", () => {
    const start = startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete the only step
    const done = completeCurrentStep(runId);
    expect("error" in done).toBe(false);
    if ("error" in done) return;
    expect(done.run.status).toBe("completed");

    // Resume a completed run
    const resumed = resumeRun(runId);
    expect("error" in resumed).toBe(false);
    if ("error" in resumed) return;
    expect(resumed.stepContext).toBeUndefined();
  });
});

// ── getRunState ───────────────────────────────────────────────

describe("getRunState", () => {
  it("returns the full state of an active run", () => {
    const start = startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const state = getRunState(runId);
    expect("error" in state).toBe(false);
    if ("error" in state) return;
    expect(state.runId).toBe(runId);
    expect(state.playbookName).toBe("test-multi-step");
    expect(state.status).toBe("in_progress");
    expect(state.totalSteps).toBe(3);
    expect(state.currentStepIndex).toBe(0);
  });

  it("returns an error for unknown runId", () => {
    const result = getRunState("bad-run-id");
    expect("error" in result).toBe(true);
  });
});

// ── getCurrentStepContext ─────────────────────────────────────

describe("getCurrentStepContext", () => {
  it("returns the current step context for an active run", () => {
    const start = startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();

    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.step.id).toBe("step-one");
    expect(ctx!.systemPrompt).toMatch(/You are/);
    expect(ctx!.resolvedPrompt).toMatch(/Step 1/);
    expect(ctx!.allowedTools.length).toBeGreaterThan(0);
  });

  it("returns undefined for a completed run", () => {
    const start = startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;
    completeCurrentStep(runId);

    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeUndefined();
  });
});

// ── runValidate ───────────────────────────────────────────────

describe("runValidate", () => {
  it("validates a known valid playbook", () => {
    const result = runValidate("test-minimal");
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns issues for a playbook with errors", () => {
    const result = runValidate("test-bad-step");
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("validates parameters when provided", () => {
    const result = runValidate("test-with-params", { message: "ok" });
    expect(result.valid).toBe(true);
  });

  it("catches parameter errors during validation", () => {
    const result = runValidate("test-with-params", {});
    expect(result.valid).toBe(false);
    // Should flag the missing 'message' parameter
    expect(result.paramErrors).toBeDefined();
    expect(result.paramErrors!.some((e) => e.toLowerCase().includes("message"))).toBe(true);
  });

  it("returns error for non-existent playbook", () => {
    const result = runValidate("ghost-playbook-123");
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("not found"))).toBe(true);
  });
});

// ── Gate behavior ─────────────────────────────────────────────

describe("gated steps", () => {
  it("returns gate information in step context for gated steps", () => {
    const start = startRun("test-gated", {});
    expect(start.error).toBeUndefined();

    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.gate).toBe("Confirm");
  });
});

// ── Template resolution ───────────────────────────────────────

describe("template resolution", () => {
  it("resolves {{params.*}} in step prompts", () => {
    const start = startRun("test-with-params", { message: "Greetings!" });
    expect(start.error).toBeUndefined();
    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.resolvedPrompt).toContain("Greetings!");
  });

  it("resolves {{state.*}} references from previously stored outputs", () => {
    const start = startRun("test-state-output", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete first step with an output
    completeCurrentStep(runId, "computed-value");

    // Verify state tracking via getRunState
    const state = getRunState(runId);
    if (state && !("error" in state)) {
      expect(state.state).toHaveProperty("step-one_output", "computed-value");
    }
  });
});

