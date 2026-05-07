/**
 * End-to-end MCP transport tests.
 *
 * Exercises the MCP server through the InMemoryTransport to verify
 * that tool handlers, error formatting, and protocol-level behaviors
 * work end-to-end (beyond the unit/integration tests on loader/executor).
 *
 * These tests do NOT depend on actual playbooks on disk; they verify
 * the server wiring is correct regardless of playbook availability.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import { listPlaybooks, startRun, getRunState, runValidate } from "../executor.js";
import { resolveSearchPaths } from "../loader.js";
import { ErrorCode, makeError, type McpErrorResult } from "../errors.js";

// ─── Replicate server wiring from index.ts ──────────────────

const MAX_INPUT_SIZE = 1_048_576;

function createTextResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function createErrorResult(err: McpErrorResult): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `❌ [${err.code}] ${err.message}${err.details ? `\n\nDetails: ${JSON.stringify(err.details, null, 2)}` : ""}`,
      },
    ],
    isError: true,
  };
}

function checkInputSize(
  name: string,
  args: Record<string, unknown> | undefined,
): McpErrorResult | null {
  const raw = JSON.stringify(args ?? {});
  if (Buffer.byteLength(raw, "utf-8") > MAX_INPUT_SIZE) {
    return makeError(
      ErrorCode.INPUT_TOO_LARGE,
      `Tool '${name}' input exceeds maximum size of ${MAX_INPUT_SIZE} bytes`,
      { tool: name, size: Buffer.byteLength(raw, "utf-8") },
    );
  }
  return null;
}

describe("MCP Server E2E (InMemoryTransport)", () => {
  let server: Server;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    server = new Server(
      {
        name: "playbooks-mcp",
        version: "1.0.0",
      },
      {
        capabilities: { tools: {} },
      },
    );

    // Wire up tools list
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "health_check",
          description: "Health check / readiness probe.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_playbooks",
          description: "Discover available playbooks.",
          inputSchema: {
            type: "object",
            properties: {
              tag: { type: "string", description: "Optional tag to filter by" },
            },
          },
        },
        {
          name: "run_playbook",
          description: "Execute a playbook.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the playbook",
              },
              params: {
                type: "object",
                description: "Parameters",
                additionalProperties: true,
              },
            },
            required: ["name"],
          },
        },
        {
          name: "get_playbook_state",
          description: "Get run state.",
          inputSchema: {
            type: "object",
            properties: {
              runId: { type: "string", description: "Run ID" },
            },
            required: ["runId"],
          },
        },
        {
          name: "validate_playbook",
          description: "Validate a playbook.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Playbook name" },
              params: {
                type: "object",
                description: "Optional params",
                additionalProperties: true,
              },
            },
            required: ["name"],
          },
        },
      ],
    }));

    // Wire up tool call handler (mirrors index.ts)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Input size guard
      const sizeErr = checkInputSize(name, args as Record<string, unknown> | undefined);
      if (sizeErr) return createErrorResult(sizeErr);

      try {
        switch (name) {
          case "health_check": {
            let searchPaths: string[] = [];
            try {
              searchPaths = resolveSearchPaths();
            } catch {
              // ignore
            }
            return createTextResult(
              [
                "## 🟢 Server Healthy",
                "",
                `- **Version:** 1.0.0`,
                `- **Search paths:** ${searchPaths.length > 0 ? searchPaths.join(", ") : "(none found)"}`,
              ].join("\n"),
            );
          }

          case "list_playbooks": {
            const tag = args?.tag as string | undefined;
            const playbooks = listPlaybooks(tag);
            if (playbooks.length === 0) {
              return createTextResult(
                "No playbooks found. Create a `.openmono/playbooks/<name>/PLAYBOOK.md` file to define one.",
              );
            }
            return createTextResult(`Found ${playbooks.length} playbook(s)`);
          }

          case "run_playbook": {
            const pbName = args?.name as string;
            const params = (args?.params as Record<string, unknown>) ?? {};
            const result = startRun(pbName, params);
            if (result.error) {
              return createTextResult(`❌ ${result.error}`, true);
            }
            return createTextResult(`✅ Started run: ${result.run.runId}`);
          }

          case "get_playbook_state": {
            const runId = args?.runId as string;
            const result = getRunState(runId);
            if ("error" in result) {
              return createTextResult(`❌ ${result.error}`, true);
            }
            return createTextResult(`Run state: ${result.status}`);
          }

          case "validate_playbook": {
            const pbName = args?.name as string;
            const params = args?.params as Record<string, unknown> | undefined;
            const result = runValidate(pbName, params);
            if (result.valid) {
              return createTextResult(`✅ Valid`);
            }
            return createTextResult(`❌ Invalid: ${result.issues.length} issues`);
          }

          default:
            return createTextResult(`Unknown tool: ${name}`, true);
        }
      } catch (err) {
        return createErrorResult(
          makeError(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
        );
      }
    });

    await server.connect(serverTransport);
  });

  afterAll(async () => {
    try {
      await serverTransport.close();
      await clientTransport.close();
    } catch {
      // ignore
    }
  });

  // ─── Helper: send a request and wait for the matching response ───

  function request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = Math.floor(Math.random() * 1_000_000);
    const msg: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    void clientTransport.send(msg as unknown as JSONRPCMessage);

    return new Promise<Record<string, unknown>>((resolve) => {
      const handler = (message: JSONRPCMessage) => {
        // Narrow: check if it's a response (result or error) matching our id
        const m = message as Record<string, unknown>;
        if (m.id === id && ("result" in m || "error" in m)) {
          clientTransport.onmessage = undefined;
          resolve(m);
        }
      };
      clientTransport.onmessage = handler;
    });
  }

  function getTextContent(msg: Record<string, unknown>): string {
    const result = msg.result as { content?: { type: string; text?: string }[] } | undefined;
    if (result?.content?.[0]?.text) {
      return result.content[0].text;
    }
    return "";
  }

  function isError(msg: Record<string, unknown>): boolean {
    const result = msg.result as { isError?: boolean } | undefined;
    return result?.isError === true;
  }

  // ─── Tests ──────────────────────────────────────────────

  it("responds to ListTools request", async () => {
    const response = await request("tools/list");

    expect("result" in response).toBe(true);
    const result = response.result as { tools?: { name: string }[] };
    expect(result.tools).toBeInstanceOf(Array);
    expect(result.tools!.length).toBeGreaterThanOrEqual(5);

    const toolNames = result.tools!.map((t) => t.name);
    expect(toolNames).toContain("health_check");
    expect(toolNames).toContain("list_playbooks");
    expect(toolNames).toContain("run_playbook");
    expect(toolNames).toContain("get_playbook_state");
    expect(toolNames).toContain("validate_playbook");
  });

  it("handles health_check tool call", async () => {
    const response = await request("tools/call", { name: "health_check", arguments: {} });

    expect("error" in response).toBe(false);
    const text = getTextContent(response);
    expect(text).toContain("🟢 Server Healthy");
  });

  it("handles list_playbooks tool call", async () => {
    const response = await request("tools/call", { name: "list_playbooks", arguments: {} });

    const text = getTextContent(response);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("reports error for run_playbook with unknown playbook", async () => {
    const response = await request("tools/call", {
      name: "run_playbook",
      arguments: { name: "nonexistent-playbook-12345" },
    });

    expect(isError(response)).toBe(true);
    expect(getTextContent(response)).toContain("not found");
  });

  it("reports error for get_playbook_state with unknown runId", async () => {
    const response = await request("tools/call", {
      name: "get_playbook_state",
      arguments: { runId: "nonexistent-run-12345" },
    });

    expect(isError(response)).toBe(true);
    expect(getTextContent(response)).toContain("not found");
  });

  it("validates unknown playbook with errors", async () => {
    const response = await request("tools/call", {
      name: "validate_playbook",
      arguments: { name: "nonexistent-playbook-12345" },
    });

    expect(getTextContent(response)).toContain("Invalid");
  });

  it("handles unknown tool", async () => {
    const response = await request("tools/call", {
      name: "nonexistent_tool",
      arguments: {},
    });

    expect(isError(response)).toBe(true);
    expect(getTextContent(response)).toContain("Unknown tool");
  });

  it("rejects oversized input", async () => {
    const largeString = "x".repeat(1_100_000);
    const response = await request("tools/call", {
      name: "run_playbook",
      arguments: { name: "test", params: { huge: largeString } },
    });

    expect(isError(response)).toBe(true);
    expect(getTextContent(response)).toMatch(/INPUT_TOO_LARGE|exceeds maximum size/i);
  });
});
