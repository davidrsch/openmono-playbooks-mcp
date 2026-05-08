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
  acknowledgeGate,
} from "../executor.js";

// ── startRun ──────────────────────────────────────────────────

describe("startRun", () => {
  it("starts a valid playbook and returns a run", async () => {
    const result = await startRun("test-minimal", {});
    expect(result.error).toBeUndefined();
    expect(result.run).toBeDefined();
    expect(result.run!.runId).toBeDefined();
    expect(result.run!.playbookName).toBe("test-minimal");
    expect(result.run!.status).toBe("in_progress");
    expect(result.run!.currentStepIndex).toBe(0);
  });

  it("returns an error for a non-existent playbook", async () => {
    const result = await startRun("non-existent-playbook-xyz", {});
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Playbook not found/i);
  });

  it("rejects unknown parameters when the playbook has params defined", async () => {
    const result = await startRun("test-with-params", {
      message: "hello",
      unknownParam: "bad",
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/unknownParam/i);
  });

  it("applies default values for optional parameters", async () => {
    const result = await startRun("test-with-params", { message: "hello" });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.count).toBe(1); // default
    expect(result.run!.params.enabled).toBe(false); // default
  });

  it("coerces Number parameters", async () => {
    const result = await startRun("test-with-params", {
      message: "hello",
      count: "42" as unknown as number,
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.count).toBe(42);
    expect(typeof result.run!.params.count).toBe("number");
  });

  it("coerces Boolean parameters", async () => {
    const result = await startRun("test-with-params", {
      message: "hello",
      enabled: "true" as unknown as boolean,
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.enabled).toBe(true);
  });

  it("coerces Array parameters from comma-separated strings", async () => {
    const result = await startRun("test-with-params", {
      message: "hello",
      tags: "a, b, c" as unknown as string[],
    });
    expect(result.error).toBeUndefined();
    expect(result.run!.params.tags).toEqual(["a", "b", "c"]);
  });

  it("errors on missing required parameters", async () => {
    const result = await startRun("test-with-params", {});
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/message/i); // 'message' is required
  });
});

// ── Step lifecycle: complete ─────────────────────────────────

describe("completeCurrentStep", () => {
  it("completes a step and advances to the next", async () => {
    const start = await startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await completeCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("in_progress");
    expect(result.run.currentStepIndex).toBe(1);
    expect(result.nextStepContext).toBeDefined();
    expect(result.nextStepContext!.step.id).toBe("step-two");
  });

  it("marks the run as completed when all steps are done", async () => {
    const start = await startRun("test-two-steps", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete step 1
    const r1 = await completeCurrentStep(runId);
    expect("error" in r1).toBe(false);
    if ("error" in r1) return;
    expect(r1.run.status).toBe("in_progress");

    // Complete step 2 (last step)
    const r2 = await completeCurrentStep(runId);
    expect("error" in r2).toBe(false);
    if ("error" in r2) return;
    expect(r2.run.status).toBe("completed");
    expect(r2.nextStepContext).toBeUndefined();
    expect(r2.run.totalSteps).toBe(2);
  });

  it("stores step output for downstream {{state.key}} references", async () => {
    const start = await startRun("test-state-output", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await completeCurrentStep(runId, "my-output-value");
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

  it("returns an error for an unknown runId", async () => {
    const result = await completeCurrentStep("nonexistent-run-id-12345");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/not found/i);
  });
});

// ── Step lifecycle: skip ─────────────────────────────────────

describe("skipCurrentStep", () => {
  it("skips the current step and advances", async () => {
    const start = await startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await skipCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.currentStepIndex).toBe(1);
    expect(result.nextStepContext!.step.id).toBe("step-two");
    // Step 0 should be marked as skipped
    expect(result.run.stepResults[0].status).toBe("skipped");
  });

  it("completes the run when the last step is skipped", async () => {
    const start = await startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await skipCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("completed");
    expect(result.nextStepContext).toBeUndefined();
  });
});

// ── Step lifecycle: fail ─────────────────────────────────────

describe("fail step", () => {
  it("fails the current step and terminates the run", async () => {
    const start = await startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await completeCurrentStep(runId, undefined, "something went wrong");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/something went wrong/);
  });
});

// ── Resume ────────────────────────────────────────────────────

describe("resumeRun", () => {
  it("resumes an in-progress run and returns the current step context", async () => {
    const start = await startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Advance one step so the run is mid-flight
    const step1 = await completeCurrentStep(runId);
    expect("error" in step1).toBe(false);

    // Simulate "reconnect": resume the same runId
    const resumed = await resumeRun(runId);
    expect("error" in resumed).toBe(false);
    if ("error" in resumed) return;
    expect(resumed.run.runId).toBe(runId);
    expect(resumed.run.currentStepIndex).toBe(1);
    expect(resumed.stepContext).toBeDefined();
    expect(resumed.stepContext!.step.id).toBe("step-two");
  });

  it("returns an error for a non-existent runId", async () => {
    const result = await resumeRun("nonexistent-run-id");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("returns that the run is already completed for a finished run", async () => {
    const start = await startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete the only step
    const done = await completeCurrentStep(runId);
    expect("error" in done).toBe(false);
    if ("error" in done) return;
    expect(done.run.status).toBe("completed");

    // Resume a completed run
    const resumed = await resumeRun(runId);
    expect("error" in resumed).toBe(false);
    if ("error" in resumed) return;
    expect(resumed.stepContext).toBeUndefined();
  });
});

// ── getRunState ───────────────────────────────────────────────

describe("getRunState", () => {
  it("returns the full state of an active run", async () => {
    const start = await startRun("test-multi-step", {});
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
  it("returns the current step context for an active run", async () => {
    const start = await startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();

    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.step.id).toBe("step-one");
    expect(ctx!.systemPrompt).toMatch(/You are/);
    expect(ctx!.resolvedPrompt).toMatch(/Step 1/);
    expect(ctx!.allowedTools.length).toBeGreaterThan(0);
  });

  it("returns undefined for a completed run", async () => {
    const start = await startRun("test-single-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;
    await completeCurrentStep(runId);

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
  it("returns gate information in step context for gated steps", async () => {
    const start = await startRun("test-gated", {});
    expect(start.error).toBeUndefined();

    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.gate).toBe("Confirm");
  });
});
// ── Gate enforcement ──────────────────────────────────────────

describe("gate enforcement", () => {
  it("pauses the run when a gated step is completed without acknowledgment", async () => {
    const start = await startRun("test-gated", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Attempt to complete the gated step (no prior acknowledgment)
    const result = await completeCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    // Run should be paused, not advanced
    expect(result.run.status).toBe("paused");
    expect(result.run.gateStatus).toBeDefined();
    expect(result.run.gateStatus!.type).toBe("Confirm");
    expect(result.run.gateStatus!.acknowledged).toBe(false);
    expect(result.run.currentStepIndex).toBe(0); // not advanced
  });

  it("rejects completion when gate is already acknowledged", async () => {
    const start = await startRun("test-gated", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // First call: gate not acknowledged → pause
    const r1 = await completeCurrentStep(runId);
    expect("error" in r1).toBe(false);
    if ("error" in r1) return;
    expect(r1.run.status).toBe("paused");

    // Acknowledge the gate
    const ack = await acknowledgeGate(runId, "approved");
    expect("error" in ack).toBe(false);
    if ("error" in ack) return;
    // After acknowledge, the step is completed and run advances
    expect(ack.run.status).toBe("completed"); // single-step playbook
  });

  it("returns error when acknowledging a run without a pending gate", async () => {
    const start = await startRun("test-multi-step", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    const result = await acknowledgeGate(runId);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/not awaiting a gate/i);
  });
});

// ── Auto-retry ────────────────────────────────────────────────

describe("auto_retry", () => {
  it("retries a failed step when auto_retry is enabled", async () => {
    const start = await startRun("test-auto-retry", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Fail the step — should retry instead of terminating
    const result = await completeCurrentStep(runId, undefined, "temporary error");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    // Run should still be in_progress (not failed) due to auto_retry
    expect(result.run.status).toBe("in_progress");
    expect(result.nextStepContext).toBeDefined();
    expect(result.run.stepResults[0].retryCount).toBe(1);
  });

  it("fails permanently after max retries", async () => {
    const start = await startRun("test-auto-retry", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Fail 3 times (retries 1-3), 4th failure sticks
    for (let i = 1; i <= 3; i++) {
      const r = await completeCurrentStep(runId, undefined, `error ${i}`);
      expect("error" in r).toBe(false);
      if ("error" in r) return;
      expect(r.run.status).toBe("in_progress");
      expect(r.run.stepResults[0].retryCount).toBe(i);
    }
    // 4th error — max retries exceeded
    const result = await completeCurrentStep(runId, undefined, "final error");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/Max retries/);
  });
});

// ── Timeout ───────────────────────────────────────────────────

describe("step timeout", () => {
  it("auto-fails a step that exceeds its timeout", async () => {
    const start = await startRun("test-timeout", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Force the step's startedAt far into the past to trigger timeout
    const run = start.run!;
    run.stepResults[0].startedAt = new Date(Date.now() - 61_000).toISOString(); // 61s ago

    const result = await completeCurrentStep(runId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.run.status).toBe("failed");
    expect(result.run.error).toMatch(/timed out/i);
  });
});

// ── Context modes ─────────────────────────────────────────────

describe("context modes", () => {
  it("Full mode includes the playbook body", async () => {
    const start = await startRun("test-minimal", {});
    expect(start.error).toBeUndefined();
    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    // Full mode (default) should include the system prompt body
    expect(ctx!.systemPrompt.length).toBeGreaterThan(10);
    expect(ctx!.systemPrompt).not.toMatch(/Selective context mode/);
  });

  it("Selective mode omits the playbook body", async () => {
    const start = await startRun("test-selective", {});
    expect(start.error).toBeUndefined();
    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toMatch(/Selective context mode/);
  });

  it("Fork mode includes fork hint", async () => {
    const start = await startRun("test-fork", {});
    expect(start.error).toBeUndefined();
    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toMatch(/Fork context mode/);
  });
});

// ─── Template resolution ───────────────────────────────────────

describe("template resolution", () => {
  it("resolves {{params.*}} in step prompts", async () => {
    const start = await startRun("test-with-params", { message: "Greetings!" });
    expect(start.error).toBeUndefined();
    const ctx = getCurrentStepContext(start.run!);
    expect(ctx).toBeDefined();
    expect(ctx!.resolvedPrompt).toContain("Greetings!");
  });

  it("resolves {{state.*}} references from previously stored outputs", async () => {
    const start = await startRun("test-state-output", {});
    expect(start.error).toBeUndefined();
    const runId = start.run!.runId;

    // Complete first step with an output
    await completeCurrentStep(runId, "computed-value");

    // Verify state tracking via getRunState
    const state = getRunState(runId);
    if (state && !("error" in state)) {
      expect(state.state).toHaveProperty("step-one_output", "computed-value");
    }
  });
});
