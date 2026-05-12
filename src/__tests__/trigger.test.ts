import { describe, it, expect } from "vitest";
import { matchTrigger, findBestMatch } from "../trigger.js";
import type { PlaybookDefinition } from "../types.js";

function makePb(overrides: Partial<PlaybookDefinition> = {}): PlaybookDefinition {
  return {
    name: "test-pb",
    version: "1.0.0",
    description: "Test playbook",
    trigger: "auto",
    "trigger-patterns": [],
    body: "",
    _path: "/test/PLAYBOOK.md",
    _dir: "/test",
    ...overrides,
  };
}

describe("matchTrigger", () => {
  it("returns empty array for no matching patterns", () => {
    const pb = makePb({ "trigger-patterns": ["deploy"] });
    expect(matchTrigger("commit", [pb])).toHaveLength(0);
  });

  it("matches exact patterns", () => {
    const pb = makePb({ "trigger-patterns": ["commit"] });
    const results = matchTrigger("commit", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);
    expect(results[0].matchedPattern).toBe("commit");
  });

  it("matches case-insensitively", () => {
    const pb = makePb({ "trigger-patterns": ["Commit"] });
    const results = matchTrigger("COMMIT", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);
  });

  it("matches prefix patterns with wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["commit *"] });
    const results = matchTrigger("commit --amend", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches suffix patterns with wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["* deploy"] });
    const results = matchTrigger("canary deploy", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches substring patterns", () => {
    const pb = makePb({ "trigger-patterns": ["release"] });
    const results = matchTrigger("create release v2.0", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns multiple matches sorted by score", () => {
    const pb1 = makePb({ name: "commit", "trigger-patterns": ["commit"] });
    const pb2 = makePb({ name: "release", "trigger-patterns": ["release *"] });
    const results = matchTrigger("commit", [pb1, pb2]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // commit should score higher than release for "commit"
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });

  it("ignores playbooks with manual trigger mode", () => {
    const pb = makePb({
      trigger: "manual",
      "trigger-patterns": ["commit"],
    });
    expect(matchTrigger("commit", [pb])).toHaveLength(0);
  });

  it("matches playbooks with 'both' trigger mode", () => {
    const pb = makePb({
      trigger: "both",
      "trigger-patterns": ["commit"],
    });
    expect(matchTrigger("commit", [pb])).toHaveLength(1);
  });

  it("ignores playbooks without trigger-patterns", () => {
    const pb = makePb({ "trigger-patterns": undefined });
    expect(matchTrigger("commit", [pb])).toHaveLength(0);
  });

  it("handles empty input gracefully", () => {
    const pb = makePb({ "trigger-patterns": ["commit"] });
    expect(matchTrigger("", [pb])).toHaveLength(0);
  });

  it("matches pattern starting with wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["* code review"] });
    const results = matchTrigger("do a code review", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches pattern ending with wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["create *"] });
    const results = matchTrigger("create release", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches pattern with wildcard in middle", () => {
    const pb = makePb({ "trigger-patterns": ["deploy * to *"] });
    const results = matchTrigger("deploy app to staging", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches pattern with question mark wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["file?.txt"] });
    const results = matchTrigger("fileA.txt", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("multiple patterns, first non-matching", () => {
    const pb = makePb({ "trigger-patterns": ["deploy", "commit"] });
    const results = matchTrigger("commit", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);
  });

  it("pattern with only wildcard", () => {
    const pb = makePb({ "trigger-patterns": ["*"] });
    const results = matchTrigger("anything", [pb]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });
});

describe("findBestMatch", () => {
  it("returns the highest-scoring match", () => {
    const pb1 = makePb({ name: "commit", "trigger-patterns": ["commit *"] });
    const pb2 = makePb({ name: "commit-exact", "trigger-patterns": ["commit"] });
    const result = findBestMatch("commit", [pb1, pb2]);
    expect(result).not.toBeNull();
    expect(result!.playbook.name).toBe("commit-exact");
  });

  it("returns null when no match found", () => {
    const pb = makePb({ "trigger-patterns": ["deploy"] });
    expect(findBestMatch("commit", [pb])).toBeNull();
  });
});
