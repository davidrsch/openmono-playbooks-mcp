/**
 * Integration tests for the playbook loader module.
 *
 * Covers:
 *  - Parsing valid PLAYBOOK.md files
 *  - Handling missing / malformed frontmatter
 *  - Required field validation
 *  - Step dependency cycles and topological sort
 *  - Normalization helpers (trigger, context-mode, gates, parameters)
 *  - ValidatePlaybook issues
 */

import { describe, it, expect } from "vitest";
import {
  parsePlaybookString,
  validatePlaybook,
} from "../loader.js";

const MINIMAL_VALID_YAML = `name: minimal
version: 1.0.0
description: A minimal valid playbook`;

function makePlaybook(yamlBlock: string, body = ""): string {
  return `---\n${yamlBlock}\n---\n${body}`;
}

describe("parsePlaybookString", () => {
  it("parses a minimal valid playbook", () => {
    const raw = makePlaybook(MINIMAL_VALID_YAML, "# Hello");
    const def = parsePlaybookString(raw, "<test>");
    expect(def.name).toBe("minimal");
    expect(def.version).toBe("1.0.0");
    expect(def.description).toBe("A minimal valid playbook");
    expect(def.trigger).toBe("manual");
    expect(def["user-invocable"]).toBe(true);
    expect(def.body).toBe("# Hello");
    expect(def._path).toBe("<test>");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parsePlaybookString("just markdown", "<test>")).toThrow(
      "No YAML frontmatter found in playbook file: <test>",
    );
  });

  it("throws when name is missing", () => {
    const raw = makePlaybook("version: 1.0.0\ndescription: x");
    expect(() => parsePlaybookString(raw, "<test>")).toThrow(
      "missing required 'name' field",
    );
  });

  it("throws when version is missing", () => {
    const raw = makePlaybook("name: test\ndescription: x");
    expect(() => parsePlaybookString(raw, "<test>")).toThrow(
      "missing required 'version' field",
    );
  });

  it("throws when description is missing", () => {
    const raw = makePlaybook("name: test\nversion: 1.0.0");
    expect(() => parsePlaybookString(raw, "<test>")).toThrow(
      "missing required 'description' field",
    );
  });

  it("defaults trigger to manual for unknown values", () => {
    const raw = makePlaybook("name: t\nversion: 1.0.0\ndescription: d\ntrigger: unknown_value");
    const def = parsePlaybookString(raw, "<test>");
    expect(def.trigger).toBe("manual");
  });

  it("normalizes trigger to auto, both, or manual", () => {
    for (const [input, expected] of [
      ["auto", "auto"],
      ["AUTO", "auto"],
      ["both", "both"],
      ["Both", "both"],
      ["manual", "manual"],
      ["", "manual"],
    ] as const) {
      const raw = makePlaybook(`name: t\nversion: 1.0.0\ndescription: d\ntrigger: ${input}`);
      expect(parsePlaybookString(raw, "<test>").trigger).toBe(expected);
    }
  });

  it("normalizes context-mode", () => {
    for (const [input, expected] of [
      ["selective", "Selective"],
      ["fork", "Fork"],
      ["full", "Full"],
      ["", "Full"],
    ] as const) {
      const raw = makePlaybook(`name: t\nversion: 1.0.0\ndescription: d\ncontext-mode: ${input}`);
      expect(parsePlaybookString(raw, "<test>")["context-mode"]).toBe(expected);
    }
  });

  it("parses parameters with types and defaults", () => {
    const raw = makePlaybook(`
name: params-test
version: 1.0.0
description: Testing parameters
parameters:
  name:
    type: String
    required: true
  count:
    type: Number
    default: 5
    min: 0
    max: 100
  enabled:
    type: Boolean
    default: false
  items:
    type: Array
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.parameters).toBeDefined();
    expect(def.parameters!.name.type).toBe("String");
    expect(def.parameters!.name.required).toBe(true);
    expect(def.parameters!.count.type).toBe("Number");
    expect(def.parameters!.count.default).toBe(5);
    expect(def.parameters!.count.min).toBe(0);
    expect(def.parameters!.count.max).toBe(100);
    expect(def.parameters!.enabled.type).toBe("Boolean");
    expect(def.parameters!.items.type).toBe("Array");
  });

  it("falls back to String for unknown parameter types", () => {
    const raw = makePlaybook(`
name: t
version: 1.0.0
description: d
parameters:
  weird:
    type: FloatyThing
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.parameters!.weird.type).toBe("String");
  });
});

describe("parsePlaybookString — steps", () => {
  it("parses steps with ids", () => {
    const raw = makePlaybook(`
name: steps-test
version: 1.0.0
description: Test steps
steps:
  - id: analyze
    inline-prompt: Do the analysis
  - id: fix
    inline-prompt: Apply the fix
    requires:
      - analyze
    gate: Confirm
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.steps).toHaveLength(2);
    expect(def.steps![0].id).toBe("analyze");
    expect(def.steps![1].id).toBe("fix");
    expect(def.steps![1].requires).toEqual(["analyze"]);
    expect(def.steps![1].gate).toBe("Confirm");
  });

  it("topologically sorts steps by dependencies", () => {
    const raw = makePlaybook(`
name: sort-test
version: 1.0.0
description: Topological sort test
steps:
  - id: deploy
    requires:
      - test
      - build
  - id: test
    requires:
      - build
  - id: build
  - id: lint
`);
    const def = parsePlaybookString(raw, "<test>");
    const ids = def.steps!.map((s) => s.id);
    // build and lint have indegree 0, then test depends on build, then deploy depends on test + build
    expect(ids.indexOf("build")).toBeLessThan(ids.indexOf("test"));
    expect(ids.indexOf("test")).toBeLessThan(ids.indexOf("deploy"));
    // lint has no deps and should come before deploy
    expect(ids.indexOf("lint")).toBeLessThan(ids.indexOf("deploy"));
  });

  it("auto-generates ids for steps without them", () => {
    const raw = makePlaybook(`
name: auto-id
version: 1.0.0
description: Auto-generated ids
steps:
  - inline-prompt: step one
  - inline-prompt: step two
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.steps![0].id).toBe("step-00");
    expect(def.steps![1].id).toBe("step-01");
  });

  it("handles steps with sub-playbook references", () => {
    const raw = makePlaybook(`
name: sub-ref
version: 1.0.0
description: Sub-playbook test
steps:
  - id: call-sub
    playbook: other-playbook
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.steps![0].playbook).toBe("other-playbook");
  });
});

describe("parsePlaybookString — constraints", () => {
  it("parses constraints", () => {
    const raw = makePlaybook(`
name: constraints-test
version: 1.0.0
description: With constraints
constraints:
  - rule: Do not delete anything
    severity: error
  - rule: Prefer async patterns
    severity: warning
    reason: Performance
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.constraints).toHaveLength(2);
    expect(def.constraints![0].rule).toBe("Do not delete anything");
    expect(def.constraints![0].severity).toBe("error");
    expect(def.constraints![1].severity).toBe("warning");
    expect(def.constraints![1].reason).toBe("Performance");
  });

  it("returns undefined for empty constraints", () => {
    const raw = makePlaybook(MINIMAL_VALID_YAML);
    expect(parsePlaybookString(raw, "<test>").constraints).toBeUndefined();
  });
});

describe("validatePlaybook", () => {
  it("reports invalid SemVer versions", () => {
    const raw = makePlaybook("name: t\nversion: not-semver\ndescription: d");
    const def = parsePlaybookString(raw, "<test>");
    const issues = validatePlaybook(def);
    const versionIssue = issues.find((i) => i.field === "version");
    expect(versionIssue).toBeDefined();
    expect(versionIssue!.severity).toBe("error");
  });

  it("accepts valid SemVer versions", () => {
    const raw = makePlaybook("name: t\nversion: 2.3.1-beta\ndescription: d");
    const def = parsePlaybookString(raw, "<test>");
    const issues = validatePlaybook(def);
    expect(issues.filter((i) => i.field === "version")).toHaveLength(0);
  });

  it("flags steps with no file, inline-prompt, or playbook", () => {
    const raw = makePlaybook(`
name: bad-step
version: 1.0.0
description: Missing step content
steps:
  - id: empty-step
`);
    const def = parsePlaybookString(raw, "<test>");
    const issues = validatePlaybook(def);
    const stepIssues = issues.filter((i) => i.field.startsWith("steps["));
    expect(stepIssues.length).toBeGreaterThan(0);
    expect(stepIssues[0].message).toMatch(/no file, inline-prompt, or playbook/i);
  });

  it("flags steps that depend on non-existent step ids", () => {
    const raw = makePlaybook(`
name: bad-deps
version: 1.0.0
description: Bad dependencies
steps:
  - id: one
    inline-prompt: step one
    requires:
      - ghost-step
`);
    const def = parsePlaybookString(raw, "<test>");
    const issues = validatePlaybook(def);
    const depIssue = issues.find((i) =>
      i.message.includes("non-existent step"),
    );
    expect(depIssue).toBeDefined();
    expect(depIssue!.severity).toBe("error");
  });

  it("returns no issues for a valid playbook with steps", () => {
    const raw = makePlaybook(`
name: valid
version: 1.0.0
description: A valid playbook with steps
steps:
  - id: first
    inline-prompt: Do the first thing
  - id: second
    inline-prompt: Do the second thing
    requires:
      - first
`);
    const def = parsePlaybookString(raw, "<test>");
    const issues = validatePlaybook(def);
    expect(issues).toHaveLength(0);
  });
});

describe("parsePlaybookString — tags and user-invocable", () => {
  it("parses tags", () => {
    const raw = makePlaybook(`
name: tagged
version: 1.0.0
description: With tags
tags:
  - git
  - ci
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def.tags).toEqual(["git", "ci"]);
  });

  it("user-invocable defaults to true", () => {
    const def = parsePlaybookString(makePlaybook(MINIMAL_VALID_YAML), "<test>");
    expect(def["user-invocable"]).toBe(true);
  });

  it("user-invocable can be set to false", () => {
    const raw = makePlaybook(`
name: hidden
version: 1.0.0
description: Not user invocable
user-invocable: false
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def["user-invocable"]).toBe(false);
  });

  it("parses allowed-tools and depends-on", () => {
    const raw = makePlaybook(`
name: tooled
version: 1.0.0
description: With tools
allowed-tools:
  - read_file
  - execute_command
depends-on:
  - base-playbook
`);
    const def = parsePlaybookString(raw, "<test>");
    expect(def["allowed-tools"]).toEqual(["read_file", "execute_command"]);
    expect(def["depends-on"]).toEqual(["base-playbook"]);
  });
});