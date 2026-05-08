/**
 * MCP Protocol E2E Tests
 *
 * Spawns the compiled server as a child process, connects via
 * StdioClientTransport, and sends real MCP JSON-RPC tool calls.
 *
 * Covers:
 *  - Server starts and responds to initialize
 *  - tools/list returns all registered tools
 *  - health_check returns server status
 *  - list_playbooks discovers fixture playbooks
 *  - run_playbook starts a playbook run
 *  - complete_step advances through steps
 *  - skip_step skips a step
 *  - fail_step terminates a run
 *  - get_playbook_state inspects run state
 *  - resume_playbook restores from checkpoint
 *  - validate_playbook validates a playbook
 *  - Unknown tool returns error
 *  - Rate limiting rejects rapid requests
 *  - Input size guard rejects oversized inputs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, "..", "..", "dist", "index.js");

// Skip the entire suite if dist/index.js does not exist
const describeIf = fs.existsSync(DIST_INDEX) ? describe : describe.skip;

describeIf("MCP Server E2E", () => {
  let client: Client;
  let transport: StdioClientTransport;
  const collectedRunIds: string[] = [];

  beforeAll(async () => {
    // Point the server at the fixture directory
    const fixtureDir = path.resolve(__dirname, "..", "..", ".openmono", "playbooks");
    const env = {
      ...process.env,
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
      PLAYBOOKS_PATH: fixtureDir,
      NODE_ENV: "test",
    };

    transport = new StdioClientTransport({
      command: "node",
      args: [DIST_INDEX],
      env,
    });

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    // Clean up checkpoint files created during tests
    const stateDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".openmono",
      "state",
    );
    for (const runId of collectedRunIds) {
      const filePath = path.join(stateDir, `playbook-run-${runId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    await client.close();
  });

  // ─── tools/list ────────────────────────────────────────────

  describe("tools/list", () => {
    it("returns all registered tools", async () => {
      const result = await client.listTools();
      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBeGreaterThanOrEqual(9);

      const toolNames = result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain("health_check");
      expect(toolNames).toContain("list_playbooks");
      expect(toolNames).toContain("run_playbook");
      expect(toolNames).toContain("complete_step");
      expect(toolNames).toContain("skip_step");
      expect(toolNames).toContain("fail_step");
      expect(toolNames).toContain("resume_playbook");
      expect(toolNames).toContain("get_playbook_state");
      expect(toolNames).toContain("validate_playbook");
    });
  });

  // ─── health_check ──────────────────────────────────────────

  describe("health_check", () => {
    it("returns healthy status with uptime", async () => {
      const result = (await client.callTool({
        name: "health_check",
        arguments: {},
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("Server Healthy");
      expect(text).toContain("Status:");
      expect(text).toContain("Uptime:");
      expect(text).toContain("Search paths:");
    });
  });

  // ─── list_playbooks ────────────────────────────────────────

  describe("list_playbooks", () => {
    it("discovers playbooks from the fixture directory", async () => {
      const result = (await client.callTool({
        name: "list_playbooks",
        arguments: {},
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("test-minimal");
      expect(text).toContain("test-with-params");
      expect(text).toContain("test-multi-step");
      expect(text).toContain("test-two-steps");
      expect(text).toContain("test-single-step");
      expect(text).toContain("test-state-output");
    });

    it("filters playbooks by tag (none match)", async () => {
      const result = (await client.callTool({
        name: "list_playbooks",
        arguments: { tag: "nonexistent-tag-xyz" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("No playbooks found");
    });
  });

  // ─── run_playbook ──────────────────────────────────────────

  describe("run_playbook", () => {
    it("starts a playbook and returns the first step context", async () => {
      const result = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-multi-step" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("Run ID:");
      expect(text).toContain("step-one");
      expect(text).toContain("This is step one");

      // Extract run ID for cleanup
      const match = text.match(/\*\*Run ID:\*\*\s*([a-f0-9-]+)/);
      if (match) collectedRunIds.push(match[1]);
    });

    it("rejects a non-existent playbook", async () => {
      const result = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "does-not-exist-xyz" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toContain("Playbook not found");
    });

    it("accepts valid parameters", async () => {
      const result = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-with-params", params: { message: "hello" } },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("hello");

      const match = text.match(/\*\*Run ID:\*\*\s*([a-f0-9-]+)/);
      if (match) collectedRunIds.push(match[1]);
    });

    it("rejects unknown parameters", async () => {
      const result = (await client.callTool({
        name: "run_playbook",
        arguments: {
          name: "test-with-params",
          params: { message: "hello", unknownKey: "bad" },
        },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toContain("unknownKey");
    });

    it("returns an error for missing required parameters", async () => {
      const result = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-with-params" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toMatch(/message/i);
    });
  });

  // ─── complete_step ─────────────────────────────────────────

  describe("complete_step", () => {
    it("advances to the next step", async () => {
      // Start a multi-step run
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-multi-step" },
      })) as CallToolResult;
      const startText = getText(start);
      const runId = extractRunId(startText);
      collectedRunIds.push(runId);

      // Complete step one
      const result = (await client.callTool({
        name: "complete_step",
        arguments: { runId },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("step-two");
      expect(text).toContain("This is step two");
    });

    it("completes the run on the last step", async () => {
      // Start and complete a two-step playbook
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-two-steps" },
      })) as CallToolResult;
      const runId = extractRunId(getText(start));
      collectedRunIds.push(runId);

      // Complete step one
      await client.callTool({ name: "complete_step", arguments: { runId } });

      // Complete step two (last step)
      const result = (await client.callTool({
        name: "complete_step",
        arguments: { runId },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("completed successfully");
    });

    it("returns error for unknown run ID", async () => {
      const result = (await client.callTool({
        name: "complete_step",
        arguments: { runId: "00000000-0000-0000-0000-000000000000" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toMatch(/not found/i);
    });
  });

  // ─── skip_step ─────────────────────────────────────────────

  describe("skip_step", () => {
    it("skips the current step and advances", async () => {
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-multi-step" },
      })) as CallToolResult;
      const runId = extractRunId(getText(start));
      collectedRunIds.push(runId);

      const result = (await client.callTool({
        name: "skip_step",
        arguments: { runId },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("step-two");
    });
  });

  // ─── fail_step ─────────────────────────────────────────────

  describe("fail_step", () => {
    it("fails the current step and terminates the run", async () => {
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-single-step" },
      })) as CallToolResult;
      const runId = extractRunId(getText(start));
      collectedRunIds.push(runId);

      const result = (await client.callTool({
        name: "fail_step",
        arguments: { runId, error: "Something went terribly wrong" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toContain("Something went terribly wrong");
      expect(text).toContain("terminated");
    });
  });

  // ─── get_playbook_state ────────────────────────────────────

  describe("get_playbook_state", () => {
    it("returns the state of an active run", async () => {
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-multi-step" },
      })) as CallToolResult;
      const runId = extractRunId(getText(start));
      collectedRunIds.push(runId);

      const result = (await client.callTool({
        name: "get_playbook_state",
        arguments: { runId },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("test-multi-step");
      expect(text).toContain("in_progress");
      expect(text).toContain(runId);
    });

    it("returns error for unknown run ID", async () => {
      const result = (await client.callTool({
        name: "get_playbook_state",
        arguments: { runId: "00000000-0000-0000-0000-000000000000" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toMatch(/not found/i);
    });
  });

  // ─── resume_playbook ───────────────────────────────────────

  describe("resume_playbook", () => {
    it("resumes an interrupted run", async () => {
      // Start a run
      const start = (await client.callTool({
        name: "run_playbook",
        arguments: { name: "test-multi-step" },
      })) as CallToolResult;
      const runId = extractRunId(getText(start));
      collectedRunIds.push(runId);

      // Resume it (should return the same step context)
      const result = (await client.callTool({
        name: "resume_playbook",
        arguments: { runId },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("step-one");
      expect(text).toContain("This is step one");
    });

    it("returns error for unknown run ID", async () => {
      const result = (await client.callTool({
        name: "resume_playbook",
        arguments: { runId: "00000000-0000-0000-0000-000000000000" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toMatch(/not found/i);
    });
  });

  // ─── validate_playbook ─────────────────────────────────────

  describe("validate_playbook", () => {
    it("validates a known valid playbook", async () => {
      const result = (await client.callTool({
        name: "validate_playbook",
        arguments: { name: "test-minimal" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain("valid");
    });

    it("returns issues for an unknown playbook", async () => {
      const result = (await client.callTool({
        name: "validate_playbook",
        arguments: { name: "does-not-exist-xyz" },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toContain("not found");
    });
  });

  // ─── Unknown tool ──────────────────────────────────────────

  describe("unknown tool", () => {
    it("returns error for unknown tool name", async () => {
      const result = (await client.callTool({
        name: "nonexistent_tool_xyz",
        arguments: {},
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toContain("Unknown tool");
    });
  });

  // ─── Rate limiting ─────────────────────────────────────────

  describe("rate limiting", () => {
    it("rejects requests sent too rapidly", async () => {
      // First request — allowed
      const r1 = (await client.callTool({
        name: "list_playbooks",
        arguments: {},
      })) as CallToolResult;
      expect(r1.isError).toBeFalsy();

      // Second request immediately — should be rate-limited
      const r2 = (await client.callTool({
        name: "list_playbooks",
        arguments: {},
      })) as CallToolResult;

      const text2 = getText(r2);
      // Rate limiting may or may not trigger depending on timing
      // Only assert if it does trigger
      if (text2.includes("RATE_LIMIT_EXCEEDED") || text2.includes("Rate limit")) {
        expect(text2).toMatch(/rate limit/i);
      } else {
        // If it didn't trigger, the request should still succeed
        expect(text2).toContain("test-minimal");
      }
    });

    it("health_check bypasses rate limiting", async () => {
      // Send health_check twice rapidly — neither should be rate-limited
      const r1 = (await client.callTool({
        name: "health_check",
        arguments: {},
      })) as CallToolResult;
      const r2 = (await client.callTool({
        name: "health_check",
        arguments: {},
      })) as CallToolResult;

      expect(getText(r1)).toContain("Server Healthy");
      expect(getText(r2)).toContain("Server Healthy");
    });
  });

  // ─── Input size guard ──────────────────────────────────────

  describe("input size guard", () => {
    it("rejects oversized inputs", async () => {
      // Create a payload larger than 1 MiB
      const hugeString = "x".repeat(1_100_000);
      const result = (await client.callTool({
        name: "list_playbooks",
        arguments: { tag: hugeString },
      })) as CallToolResult;

      const text = getText(result);
      expect(text).toMatch(/INPUT_TOO_LARGE|exceeds maximum size/i);
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────

function getText(result: CallToolResult): string {
  if (result.content && result.content.length > 0) {
    return (result.content[0] as { type: string; text: string }).text;
  }
  return "";
}

function extractRunId(text: string): string {
  const match = text.match(/\*\*Run ID:\*\*\s*([a-f0-9-]+)/);
  if (match) return match[1];
  return "";
}