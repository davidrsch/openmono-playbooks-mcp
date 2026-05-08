/**
 * Concurrency Tests
 *
 * Verifies that multiple simultaneous playbook runs do not corrupt
 * shared in-memory state and that each run maintains an independent
 * checkpoint file.
 *
 * Uses the real executor API with actual fixtures on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startRun,
  completeCurrentStep,
  skipCurrentStep,
  getRunState,
  clearActiveRuns,
} from "../executor.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function stateDir(): string {
  return path.join(os.homedir(), ".openmono", "state");
}

function cleanStateDir() {
  const dir = stateDir();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

describe("Executor Concurrency", () => {
  beforeEach(() => {
    cleanStateDir();
    clearActiveRuns();
  });

  afterEach(() => {
    cleanStateDir();
    clearActiveRuns();
  });

  it("runs two playbooks concurrently without state corruption", async () => {
    const r1 = await startRun("test-multi-step", {});
    const r2 = await startRun("test-multi-step", {});
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r1.run!.runId).not.toBe(r2.run!.runId);

    // Advance run 1 by one step
    const c1 = await completeCurrentStep(r1.run!.runId);
    expect("error" in c1).toBe(false);
    if ("error" in c1) return;
    expect(c1.run.currentStepIndex).toBe(1);

    // Run 2 should still be at step 0
    const s2 = getRunState(r2.run!.runId);
    expect("error" in s2).toBe(false);
    if ("error" in s2) return;
    expect(s2.currentStepIndex).toBe(0);

    // Advance run 2 by one step
    const c2 = await completeCurrentStep(r2.run!.runId);
    expect("error" in c2).toBe(false);
    if ("error" in c2) return;
    expect(c2.run.currentStepIndex).toBe(1);

    // Re-check run 1 — still at index 1
    const s1 = getRunState(r1.run!.runId);
    expect("error" in s1).toBe(false);
    if ("error" in s1) return;
    expect(s1.currentStepIndex).toBe(1);
  });

  it("allows one run to fail without affecting another", async () => {
    const r1 = await startRun("test-single-step", {});
    const r2 = await startRun("test-single-step", {});

    // Fail run 1 by completing its step with an error
    const f = await completeCurrentStep(r1.run!.runId, undefined, "run 1 error");
    expect("error" in f).toBe(false);
    if ("error" in f) return;
    expect(f.run.status).toBe("failed");

    // Run 2 should still be active
    const s2 = getRunState(r2.run!.runId);
    expect("error" in s2).toBe(false);
    if ("error" in s2) return;
    expect(s2.status).toBe("in_progress");

    // Run 1 should be failed
    const s1 = getRunState(r1.run!.runId);
    expect("error" in s1).toBe(false);
    if ("error" in s1) return;
    expect(s1.status).toBe("failed");
    expect(s1.error).toContain("run 1 error");
  });

  it("creates independent checkpoint files on disk for concurrent runs", async () => {
    const r1 = await startRun("test-multi-step", {});
    const r2 = await startRun("test-multi-step", {});
    const dir = stateDir();

    const files = fs.readdirSync(dir);
    const r1Files = files.filter((f) => f.includes(r1.run!.runId));
    const r2Files = files.filter((f) => f.includes(r2.run!.runId));

    expect(r1Files.length).toBe(1);
    expect(r2Files.length).toBe(1);
    expect(r1Files[0]).not.toBe(r2Files[0]);

    // Verify file contents are distinct
    const c1 = JSON.parse(
      fs.readFileSync(path.join(dir, r1Files[0]), "utf-8"),
    );
    const c2 = JSON.parse(
      fs.readFileSync(path.join(dir, r2Files[0]), "utf-8"),
    );
    expect(c1.runId).toBe(r1.run!.runId);
    expect(c2.runId).toBe(r2.run!.runId);
    expect(c1.runId).not.toBe(c2.runId);
  });

  it("handles many rapid starts without losing runs", async () => {
    const count = 20;
    const results = await Promise.all(
      Array.from({ length: count }, () =>
        startRun("test-multi-step", {}),
      ),
    );

    const ids = results.map((r) => r.run!.runId);
    const uniqueIds = new Set(ids);

    // All should start successfully
    expect(uniqueIds.size).toBe(count);

    // Verify each can be queried
    for (const id of ids) {
      const s = getRunState(id);
      expect("error" in s).toBe(false);
      if ("error" in s) return;
      expect(s.status).toBe("in_progress");
    }
  });

  it("skip operations on concurrent runs are independent", async () => {
    const r1 = await startRun("test-multi-step", {});
    const r2 = await startRun("test-multi-step", {});

    // Skip in run 1
    const s1 = await skipCurrentStep(r1.run!.runId);
    expect("error" in s1).toBe(false);

    // run 2 still at index 0
    const s2 = getRunState(r2.run!.runId);
    expect("error" in s2).toBe(false);
    if ("error" in s2) return;
    expect(s2.currentStepIndex).toBe(0);
  });
});