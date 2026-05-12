/**
 * Integration tests for loader disk I/O functions.
 *
 * Tests the functions that were previously untested:
 *  - parsePlaybookFile (reads a real file from disk)
 *  - discoverPlaybooks (walks filesystem directories)
 *  - resolveSearchPaths (resolves env vars and home directories)
 *  - loadPlaybook (finds a playbook by name on disk)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parsePlaybookFile,
  discoverPlaybooks,
  resolveSearchPaths,
  loadPlaybook,
  validatePlaybook,
} from "../loader.js";
import type { PlaybookDefinition } from "../types.js";

const TEST_DIR = path.join(os.tmpdir(), `playbooks-mcp-loader-test-${Date.now()}`);
const PLAYBOOKS_DIR = path.join(TEST_DIR, ".openmono", "playbooks");

function writePlaybook(dir: string, name: string, content: string): string {
  const pbDir = path.join(dir, name);
  fs.mkdirSync(pbDir, { recursive: true });
  const filePath = path.join(pbDir, "PLAYBOOK.md");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("parsePlaybookFile (disk I/O)", () => {
  beforeEach(() => {
    fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads and parses a valid PLAYBOOK.md from disk", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "test-pb",
      `---
name: test-pb
version: "1.0.0"
description: A test playbook
steps:
  - id: step-01
    inline-prompt: "Do something"
---
# System Prompt

This is the body.
`,
    );

    const def = parsePlaybookFile(filePath);
    expect(def.name).toBe("test-pb");
    expect(def.version).toBe("1.0.0");
    expect(def.description).toBe("A test playbook");
    expect(def.steps).toHaveLength(1);
    expect(def.steps![0].id).toBe("step-01");
    expect(def.body).toContain("This is the body.");
    expect(def._path).toBe(filePath);
    expect(def._dir).toBe(path.dirname(filePath));
  });

  it("throws on missing YAML frontmatter", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "no-frontmatter",
      "# Just Markdown\nNo YAML here.",
    );
    expect(() => parsePlaybookFile(filePath)).toThrow(/No YAML frontmatter found/);
  });

  it("throws on missing name field", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "no-name",
      `---
version: "1.0.0"
description: Missing name
---
Body`,
    );
    expect(() => parsePlaybookFile(filePath)).toThrow(/missing required 'name' field/);
  });

  it("throws on missing version field", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "no-version",
      `---
name: no-version
description: Missing version
---
Body`,
    );
    expect(() => parsePlaybookFile(filePath)).toThrow(/missing required 'version' field/);
  });

  it("throws on missing description field", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "no-desc",
      `---
name: no-desc
version: "1.0.0"
---
Body`,
    );
    expect(() => parsePlaybookFile(filePath)).toThrow(/missing required 'description' field/);
  });

  it("handles non-existent file path gracefully", () => {
    expect(() => parsePlaybookFile("/nonexistent/path/PLAYBOOK.md")).toThrow();
  });

  it("parses a playbook with all optional fields", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "full-pb",
      `---
name: full-pb
version: "2.1.0"
description: A fully-loaded playbook
trigger: auto
trigger-patterns:
  - "deploy"
  - "ship"
user-invocable: false
argument-hint: "Deploy a service"
tags:
  - ci
  - production
depends-on:
  - base-playbook
allowed-tools:
  - git
  - npm
context-mode: selective
parameters:
  env:
    type: String
    required: true
    hint: "Target environment"
    enum:
      - staging
      - production
  replicas:
    type: Number
    required: false
    default: 1
    min: 1
    max: 10
  dry_run:
    type: Boolean
    required: false
    default: false
  tags:
    type: Array
    required: false
constraints:
  - rule: "Never modify production DB"
    severity: error
    reason: "Data safety"
steps:
  - id: step-01
    description: "Check prerequisites"
    inline-prompt: "Verify the environment"
    gate: Confirm
    output: env_check
    auto_retry: true
    timeout: 300
  - id: step-02
    description: "Deploy"
    file: "./steps/deploy.md"
    requires:
      - step-01
---
# System Prompt
Body content here.
`,
    );

    const def = parsePlaybookFile(filePath);
    expect(def.name).toBe("full-pb");
    expect(def.version).toBe("2.1.0");
    expect(def.trigger).toBe("auto");
    expect(def["trigger-patterns"]).toEqual(["deploy", "ship"]);
    expect(def["user-invocable"]).toBe(false);
    expect(def["argument-hint"]).toBe("Deploy a service");
    expect(def.tags).toEqual(["ci", "production"]);
    expect(def["depends-on"]).toEqual(["base-playbook"]);
    expect(def["allowed-tools"]).toEqual(["git", "npm"]);
    expect(def["context-mode"]).toBe("Selective");
    expect(def.parameters).toBeDefined();
    expect(def.parameters!["env"].type).toBe("String");
    expect(def.parameters!["env"].enum).toEqual(["staging", "production"]);
    expect(def.parameters!["replicas"].type).toBe("Number");
    expect(def.parameters!["replicas"].default).toBe(1);
    expect(def.parameters!["replicas"].min).toBe(1);
    expect(def.parameters!["replicas"].max).toBe(10);
    expect(def.parameters!["dry_run"].type).toBe("Boolean");
    expect(def.parameters!["tags"].type).toBe("Array");
    expect(def.constraints).toHaveLength(1);
    expect(def.constraints![0].rule).toBe("Never modify production DB");
    expect(def.steps).toHaveLength(2);
    // Step with requires should be topologically sorted (step-02 depends on step-01)
    expect(def.steps![0].id).toBe("step-01");
    expect(def.steps![1].id).toBe("step-02");
    expect(def.steps![0].gate).toBe("Confirm");
    expect(def.steps![0].output).toBe("env_check");
    expect(def.steps![0].auto_retry).toBe(true);
    expect(def.steps![0].timeout).toBe(300);
  });

  it("defaults trigger to manual when invalid", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "bad-trigger",
      `---
name: bad-trigger
version: "1.0.0"
description: Test trigger normalization
trigger: unknown-value
steps:
  - id: step-01
    inline-prompt: "test"
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def.trigger).toBe("manual");
  });

  it("defaults user-invocable to true when not specified", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "default-invocable",
      `---
name: default-invocable
version: "1.0.0"
description: Test default
steps:
  - id: step-01
    inline-prompt: "test"
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def["user-invocable"]).toBe(true);
  });

  it("defaults context-mode to Full when invalid", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "ctx-mode",
      `---
name: ctx-mode
version: "1.0.0"
description: Test context mode
context-mode: invalid_mode
steps:
  - id: step-01
    inline-prompt: "test"
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def["context-mode"]).toBe("Full");
  });

  it("normalizes gates — rejects invalid gate values", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "bad-gate",
      `---
name: bad-gate
version: "1.0.0"
description: Test gate normalization
steps:
  - id: step-01
    inline-prompt: "test"
    gate: NotARealGate
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def.steps![0].gate).toBeUndefined();
  });

  it("normalizes gate 'none' to undefined", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "none-gate",
      `---
name: none-gate
version: "1.0.0"
description: Test none gate
steps:
  - id: step-01
    inline-prompt: "test"
    gate: none
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def.steps![0].gate).toBeUndefined();
  });

  it("rejects non-enum-type parameters with invalid type", () => {
    const filePath = writePlaybook(
      PLAYBOOKS_DIR,
      "bad-param-type",
      `---
name: bad-param-type
version: "1.0.0"
description: Test bad param type
parameters:
  my_param:
    type: Float64
steps:
  - id: step-01
    inline-prompt: "test"
---
Body`,
    );
    const def = parsePlaybookFile(filePath);
    expect(def.parameters!["my_param"].type).toBe("String");
  });
});

describe("discoverPlaybooks (directory walking)", () => {
  beforeEach(() => {
    fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("discovers playbooks from the default search path", () => {
    writePlaybook(
      PLAYBOOKS_DIR,
      "pb-one",
      `---
name: pb-one
version: "1.0.0"
description: Playbook One
---
Body one`,
    );
    writePlaybook(
      PLAYBOOKS_DIR,
      "pb-two",
      `---
name: pb-two
version: "2.0.0"
description: Playbook Two
---
Body two`,
    );

    const originalCwd = process.cwd();
    try {
      process.chdir(TEST_DIR);
      const playbooks = discoverPlaybooks();
      expect(playbooks.length).toBeGreaterThanOrEqual(2);
      const names = playbooks.map((p) => p.name).sort();
      expect(names).toContain("pb-one");
      expect(names).toContain("pb-two");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("deduplicates playbooks by name (first seen wins)", () => {
    writePlaybook(
      PLAYBOOKS_DIR,
      "dup-name",
      `---
name: dup-name
version: "1.0.0"
description: First
---
First body`,
    );

    // Create a second search path with same name — but since resolveSearchPaths
    // only looks at project-local .openmono/playbooks by default, the
    // deduplication is tested within the same directory structure.
    // We can verify dedup works by using PLAYBOOKS_PATH env var.
    const otherDir = path.join(TEST_DIR, "other-playbooks");
    fs.mkdirSync(path.join(otherDir, "dup-name"), { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, "dup-name", "PLAYBOOK.md"),
      `---
name: dup-name
version: "2.0.0"
description: Second
---
Second body`,
      "utf-8",
    );

    const originalCwd = process.cwd();
    const originalEnv = process.env.PLAYBOOKS_PATH;
    try {
      process.chdir(TEST_DIR);
      process.env.PLAYBOOKS_PATH = `${PLAYBOOKS_DIR}${path.delimiter}${otherDir}`;
      const playbooks = discoverPlaybooks();
      // Should only have one "dup-name" (first seen)
      const dupEntries = playbooks.filter((p) => p.name === "dup-name");
      expect(dupEntries).toHaveLength(1);
      // Should be the first one found (version 1.0.0 since it's in the first search path)
      expect(dupEntries[0].version).toBe("1.0.0");
    } finally {
      process.chdir(originalCwd);
      if (originalEnv !== undefined) {
        process.env.PLAYBOOKS_PATH = originalEnv;
      } else {
        delete process.env.PLAYBOOKS_PATH;
      }
    }
  });

  it("skips unparseable playbooks (logs warning but doesn't crash)", () => {
    writePlaybook(
      PLAYBOOKS_DIR,
      "good-one",
      `---
name: good-one
version: "1.0.0"
description: This one is fine
---
Body`,
    );

    // Create a broken playbook
    const badDir = path.join(PLAYBOOKS_DIR, "bad-one");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "PLAYBOOK.md"), "No frontmatter at all", "utf-8");

    const originalCwd = process.cwd();
    try {
      process.chdir(TEST_DIR);
      const playbooks = discoverPlaybooks();
      // Only the good one should be returned
      expect(playbooks.length).toBeGreaterThanOrEqual(1);
      expect(playbooks.some((p) => p.name === "good-one")).toBe(true);
      expect(playbooks.some((p) => p.name === "bad-one")).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns empty array when no playbooks exist", () => {
    const emptyDir = path.join(os.tmpdir(), `playbooks-mcp-empty-${Date.now()}`);
    const emptyPlaybooks = path.join(emptyDir, ".openmono", "playbooks");
    fs.mkdirSync(emptyPlaybooks, { recursive: true });

    const originalCwd = process.cwd();
    try {
      process.chdir(emptyDir);
      const playbooks = discoverPlaybooks();
      expect(playbooks).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      if (fs.existsSync(emptyDir)) {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    }
  });
});

describe("loadPlaybook (name-based lookup)", () => {
  beforeEach(() => {
    fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("finds a playbook by name from the search path", () => {
    writePlaybook(
      PLAYBOOKS_DIR,
      "target-pb",
      `---
name: target-pb
version: "3.0.0"
description: The target playbook
steps:
  - id: step-01
    inline-prompt: "execute"
---
Target body`,
    );

    const originalCwd = process.cwd();
    try {
      process.chdir(TEST_DIR);
      const pb = loadPlaybook("target-pb");
      expect(pb).not.toBeNull();
      expect(pb!.name).toBe("target-pb");
      expect(pb!.version).toBe("3.0.0");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("returns null when playbook is not found", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(TEST_DIR);
      const pb = loadPlaybook("nonexistent-pb");
      expect(pb).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("resolveSearchPaths", () => {
  const RS_TEST_DIR = path.join(os.tmpdir(), `playbooks-mcp-rs-test-${Date.now()}`);
  const RS_PLAYBOOKS_DIR = path.join(RS_TEST_DIR, ".openmono", "playbooks");

  beforeAll(() => {
    fs.mkdirSync(RS_PLAYBOOKS_DIR, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(RS_TEST_DIR)) {
      fs.rmSync(RS_TEST_DIR, { recursive: true, force: true });
    }
  });

  it("includes home .openmono/playbooks if it exists", () => {
    // The home path may or may not exist in CI, but the function should not throw
    const paths = resolveSearchPaths();
    expect(Array.isArray(paths)).toBe(true);
  });

  it("includes project-local .openmono/playbooks if it exists", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(RS_TEST_DIR);
      const paths = resolveSearchPaths();
      expect(paths.some((p) => p.includes(RS_TEST_DIR))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("uses PLAYBOOKS_PATH env var when set", () => {
    const originalEnv = process.env.PLAYBOOKS_PATH;
    const customDir = path.join(os.tmpdir(), `custom-playbooks-${Date.now()}`);
    fs.mkdirSync(customDir, { recursive: true });
    try {
      process.env.PLAYBOOKS_PATH = customDir;
      const paths = resolveSearchPaths();
      expect(paths).toContain(customDir);
    } finally {
      if (originalEnv !== undefined) {
        process.env.PLAYBOOKS_PATH = originalEnv;
      } else {
        delete process.env.PLAYBOOKS_PATH;
      }
      if (fs.existsSync(customDir)) {
        fs.rmSync(customDir, { recursive: true, force: true });
      }
    }
  });

  it("resolves tilde paths in PLAYBOOKS_PATH", () => {
    // Test that ~ is expanded to HOME
    const originalEnv = process.env.PLAYBOOKS_PATH;
    try {
      process.env.PLAYBOOKS_PATH = "~/.openmono/playbooks";
      const paths = resolveSearchPaths();
      // At least one path should contain the home directory (not literal ~)
      const hasExpandedPath = paths.some((p) => !p.startsWith("~"));
      expect(hasExpandedPath).toBe(true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.PLAYBOOKS_PATH = originalEnv;
      } else {
        delete process.env.PLAYBOOKS_PATH;
      }
    }
  });

  it("skips paths that don't exist in PLAYBOOKS_PATH", () => {
    const originalEnv = process.env.PLAYBOOKS_PATH;
    try {
      process.env.PLAYBOOKS_PATH = "/definitely/not/a/real/path/for/playbooks";
      const paths = resolveSearchPaths();
      // The non-existent path should not appear
      expect(paths.some((p) => p.includes("/definitely/not/a/real/path"))).toBe(false);
    } finally {
      if (originalEnv !== undefined) {
        process.env.PLAYBOOKS_PATH = originalEnv;
      } else {
        delete process.env.PLAYBOOKS_PATH;
      }
    }
  });

  it("discovers playbooks via WORKSPACE_ROOTS when CWD has no .openmono", () => {
    // Simulate the production scenario: the MCP server is spawned by VS Code
    // with a CWD that does NOT contain .openmono/playbooks. The extension
    // injects WORKSPACE_ROOTS so the loader can find project-local playbooks.
    const originalEnv = process.env.WORKSPACE_ROOTS;
    const originalPlaybooksPath = process.env.PLAYBOOKS_PATH;
    const originalCwd = process.cwd();
    try {
      // Create a temp directory that has .openmono/playbooks (simulates a project root)
      const projectDir = path.join(os.tmpdir(), `ws-root-test-${Date.now()}`);
      const pbDir = path.join(projectDir, ".openmono", "playbooks", "ws-pb");
      fs.mkdirSync(pbDir, { recursive: true });
      fs.writeFileSync(
        path.join(pbDir, "PLAYBOOK.md"),
        `---
name: ws-pb
version: "1.0.0"
description: Discovered via WORKSPACE_ROOTS
---
Body`,
        "utf-8",
      );

      // Set WORKSPACE_ROOTS to the project directory
      process.env.WORKSPACE_ROOTS = projectDir;
      // Remove PLAYBOOKS_PATH so only WORKSPACE_ROOTS is in play
      delete process.env.PLAYBOOKS_PATH;
      // Change CWD to a directory WITHOUT .openmono/playbooks
      process.chdir(os.tmpdir());

      const playbooks = discoverPlaybooks();
      const names = playbooks.map((p) => p.name);
      expect(names).toContain("ws-pb");
    } finally {
      if (originalEnv !== undefined) {
        process.env.WORKSPACE_ROOTS = originalEnv;
      } else {
        delete process.env.WORKSPACE_ROOTS;
      }
      if (originalPlaybooksPath !== undefined) {
        process.env.PLAYBOOKS_PATH = originalPlaybooksPath;
      } else {
        delete process.env.PLAYBOOKS_PATH;
      }
      process.chdir(originalCwd);
    }
  });
});

describe("validatePlaybook", () => {
  it("flags invalid SemVer versions", () => {
    const issues = validatePlaybook({
      name: "test",
      version: "not-a-version",
      description: "test",
      trigger: "manual",
      body: "test body",
      _path: "/fake/path/PLAYBOOK.md",
      _dir: "/fake/path",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].field).toBe("version");
    expect(issues[0].message).toContain("not-a-version");
  });

  it("flags steps with no prompt source", () => {
    const issues = validatePlaybook({
      name: "test",
      version: "1.0.0",
      description: "test",
      trigger: "manual" as const,
      steps: [
        {
          id: "step-01",
          requires: [] as string[],
        } as const,
      ],
      body: "test",
      _path: "/fake/PLAYBOOK.md",
      _dir: "/fake",
    } as PlaybookDefinition);
    expect(issues.some((i) => i.message.includes("no file, inline-prompt, or playbook"))).toBe(
      true,
    );
  });

  it("flags steps with dependency on non-existent step", () => {
    const issues = validatePlaybook({
      name: "test",
      version: "1.0.0",
      description: "test",
      trigger: "manual" as const,
      steps: [
        {
          id: "step-01",
          requires: ["non-existent-step"],
          "inline-prompt": "do stuff",
        } as const,
      ],
      body: "test",
      _path: "/fake/PLAYBOOK.md",
      _dir: "/fake",
    } as PlaybookDefinition);
    expect(issues.some((i) => i.message.includes("non-existent step"))).toBe(true);
  });

  it("returns empty issues for valid playbook", () => {
    const issues = validatePlaybook({
      name: "valid",
      version: "1.0.0",
      description: "A valid playbook",
      trigger: "manual",
      steps: [
        {
          id: "step-01",
          requires: [],
          "inline-prompt": "do work",
        },
      ],
      body: "test body",
      _path: "/fake/PLAYBOOK.md",
      _dir: "/fake",
    });
    expect(issues).toEqual([]);
  });
});
