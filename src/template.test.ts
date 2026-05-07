import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { TemplateContext } from "./template.js";

// ─── Mock node:child_process ────────────────────────────────
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// ─── Mock node:fs for file resolution tests ─────────────────
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: ((...args: unknown[]) =>
    mockExistsSync(...args)) as typeof import("node:fs").existsSync,
  readFileSync: ((...args: unknown[]) =>
    mockReadFileSync(...args)) as typeof import("node:fs").readFileSync,
}));

import { execSync } from "node:child_process";
import { resolveTemplate, resolveStepPrompt, formatConstraints } from "./template.js";

const mockExecSync = vi.mocked(execSync);

function makeCtx(overrides?: Partial<TemplateContext>): TemplateContext {
  return {
    params: {},
    state: {},
    constraints: "",
    baseDir: "/test",
    ...overrides,
  };
}

describe("template.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("resolveTemplate", () => {
    describe("params resolution", () => {
      it("resolves {{params.<key>}}", () => {
        const ctx = makeCtx({ params: { name: "Alice" } });
        expect(resolveTemplate("Hello {{params.name}}", ctx)).toBe("Hello Alice");
      });

      it("returns unresolved placeholder for missing param keys", () => {
        const ctx = makeCtx();
        expect(resolveTemplate("{{params.missing}}", ctx)).toBe("{{params.missing}}");
      });

      it("joins array params with comma and space", () => {
        const ctx = makeCtx({ params: { items: ["a", "b", "c"] } });
        expect(resolveTemplate("{{params.items}}", ctx)).toBe("a, b, c");
      });

      it("coerces null/undefined to empty string", () => {
        const ctx = makeCtx({ params: { x: null, y: undefined } });
        expect(resolveTemplate("{{params.x}}-{{params.y}}", ctx)).toBe("-");
      });

      it("resolves multiple params in same string", () => {
        const ctx = makeCtx({ params: { first: "John", last: "Doe" } });
        expect(resolveTemplate("{{params.first}} {{params.last}}", ctx)).toBe("John Doe");
      });
    });

    describe("state resolution", () => {
      it("resolves {{state.<key>}}", () => {
        const ctx = makeCtx({ state: { greeting: "hi there" } });
        expect(resolveTemplate("State: {{state.greeting}}", ctx)).toBe("State: hi there");
      });

      it("returns unresolved for missing state keys", () => {
        const ctx = makeCtx();
        expect(resolveTemplate("{{state.nope}}", ctx)).toBe("{{state.nope}}");
      });
    });

    describe("shell resolution", () => {
      it("resolves {{shell:<cmd>}} to stdout", () => {
        mockExecSync.mockReturnValue("output\n");
        const ctx = makeCtx();
        expect(resolveTemplate("Result: {{shell:pwd}}", ctx)).toBe("Result: output");
      });

      it("trims trailing newlines", () => {
        mockExecSync.mockReturnValue("some text\n\n\n");
        expect(resolveTemplate("{{shell:cmd}}", makeCtx())).toBe("some text");
      });

      it("returns unresolved on shell error", () => {
        mockExecSync.mockImplementation(() => {
          throw new Error("command failed");
        });
        expect(resolveTemplate("{{shell:bad}}", makeCtx())).toBe("{{shell:bad}}");
      });

      it("passes timeout to execSync", () => {
        mockExecSync.mockReturnValue("ok\n");
        resolveTemplate("{{shell:echo hi}}", makeCtx());
        expect(mockExecSync).toHaveBeenCalledWith("echo hi", {
          encoding: "utf-8",
          timeout: 10_000,
          windowsHide: true,
        });
      });
    });

    describe("file resolution", () => {
      it("resolves {{file:<path>}} to file contents (relative)", () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("file content\n");

        expect(resolveTemplate("Content: {{file:test.txt}}", makeCtx({ baseDir: "/app" }))).toBe(
          "Content: file content",
        );

        expect(mockExistsSync).toHaveBeenCalled();
        expect(mockReadFileSync).toHaveBeenCalled();
      });

      it("returns unresolved for missing files", () => {
        mockExistsSync.mockReturnValue(false);
        expect(resolveTemplate("{{file:nonexistent.txt}}", makeCtx())).toBe(
          "{{file:nonexistent.txt}}",
        );
      });

      it("returns unresolved on read error", () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => {
          throw new Error("permission denied");
        });
        expect(resolveTemplate("{{file:locked.txt}}", makeCtx())).toBe("{{file:locked.txt}}");
      });

      it("handles absolute paths", () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("abs content\n");
        expect(resolveTemplate("Content: {{file:/etc/hosts}}", makeCtx())).toBe(
          "Content: abs content",
        );
      });
    });

    describe("env resolution", () => {
      it("resolves {{env.<name>}}", () => {
        process.env.TEST_VAR = "test_value";
        expect(resolveTemplate("{{env.TEST_VAR}}", makeCtx())).toBe("test_value");
        delete process.env.TEST_VAR;
      });

      it("returns unresolved for missing env vars", () => {
        expect(resolveTemplate("{{env.NONEXISTENT_VAR_12345}}", makeCtx())).toBe(
          "{{env.NONEXISTENT_VAR_12345}}",
        );
      });
    });

    describe("constraints resolution", () => {
      it("resolves {{constraints}} to the constraints block", () => {
        const ctx = makeCtx({ constraints: "Keep it safe" });
        expect(resolveTemplate("Rules: {{constraints}}", ctx)).toBe("Rules: Keep it safe");
      });

      it("resolves to empty string when constraints is empty", () => {
        expect(resolveTemplate("{{constraints}}", makeCtx())).toBe("");
      });
    });

    describe("edge cases", () => {
      it("returns original string when no templates present", () => {
        expect(resolveTemplate("plain text", makeCtx())).toBe("plain text");
      });

      it("handles empty string", () => {
        expect(resolveTemplate("", makeCtx())).toBe("");
      });

      it("handles multiple template types in one string", () => {
        process.env.USER = "testuser";
        mockExecSync.mockReturnValue("home\n");
        const ctx = makeCtx({ params: { name: "Alice" }, state: { age: "30" } });
        const result = resolveTemplate(
          "{{params.name}} {{state.age}} {{shell:whoami}} {{env.USER}}",
          ctx,
        );
        expect(result).toBe("Alice 30 home testuser");
        delete process.env.USER;
      });

      it("leaves unknown template types unresolved", () => {
        expect(resolveTemplate("{{foo.bar}}", makeCtx())).toBe("{{foo.bar}}");
      });
    });
  });

  describe("resolveStepPrompt", () => {
    it("delegates to resolveTemplate", () => {
      const ctx = makeCtx({ params: { x: "1" } });
      expect(resolveStepPrompt("{{params.x}}", ctx)).toBe("1");
    });
  });

  describe("formatConstraints", () => {
    it("returns empty string for empty array", () => {
      expect(formatConstraints([])).toBe("");
    });

    it("returns empty string for undefined", () => {
      expect(formatConstraints(undefined as unknown as [])).toBe("");
    });

    it("formats error severity constraints with must prefix", () => {
      const constraints = [{ rule: "Do not delete files", severity: "error" }];
      const result = formatConstraints(constraints);
      expect(result).toContain("## Constraints / Safety Guardrails");
      expect(result).toContain("🔴 MUST:");
      expect(result).toContain("Do not delete files");
    });

    it("formats non-error constraints with should prefix", () => {
      const constraints = [{ rule: "Use TypeScript", severity: "warn" }];
      const result = formatConstraints(constraints);
      expect(result).toContain("🟡 SHOULD:");
      expect(result).toContain("Use TypeScript");
    });

    it("includes reason when provided", () => {
      const constraints = [
        {
          rule: "No hardcoded secrets",
          severity: "error",
          reason: "Security policy",
        },
      ];
      const result = formatConstraints(constraints);
      expect(result).toContain("Reason:");
      expect(result).toContain("Security policy");
    });

    it("handles multiple constraints", () => {
      const constraints = [
        { rule: "Rule 1", severity: "error", reason: "Reason 1" },
        { rule: "Rule 2", severity: "warn" },
      ];
      const result = formatConstraints(constraints);
      expect(result).toContain("Rule 1");
      expect(result).toContain("Rule 2");
      expect(result).toContain("Reason 1");
    });

    it("defaults severity to should when not specified", () => {
      const constraints = [{ rule: "Be polite" }];
      const result = formatConstraints(constraints);
      expect(result).toContain("🟡 SHOULD:");
      expect(result).toContain("Be polite");
    });
  });
});
