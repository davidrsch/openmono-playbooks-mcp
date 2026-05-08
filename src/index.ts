#!/usr/bin/env node

/**
 * OpenMono Playbooks MCP Server
 *
 * Exposes the OpenMono Playbooks workflow orchestration engine
 * to any MCP-compatible agent (Claude Desktop, Cline, Continue, etc.).
 *
 * This server makes playbooks accessible as first-class tools:
 *   - health_check        — Server readiness probe
 *   - list_playbooks      — Discover available playbooks
 *   - run_playbook        — Execute a playbook with typed parameters
 *   - resume_playbook     — Resume an interrupted playbook
 *   - get_playbook_state  — Inspect run state
 *   - validate_playbook   — Validate syntax and parameters
 *
 * Inspired by and derived from OpenMonoAgent.ai by StartupHakk.
 * See: https://github.com/StartupHakk/OpenMonoAgent.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import * as fs from "node:fs";
import * as path from "node:path";

import {
  listPlaybooks,
  startRun,
  completeCurrentStep,
  skipCurrentStep,
  resumeRun,
  getRunState,
  runValidate,
  getCurrentStepContext,
  acknowledgeGate,
} from "./executor.js";
import { resolveSearchPaths, discoverPlaybooks } from "./loader.js";
import { matchTrigger } from "./trigger.js";
import { ErrorCode, makeError, type McpErrorResult } from "./errors.js";
import { logger } from "./logger.js";

// ─── Rate Limiting & Input Guards ────────────────────────────

/** Maximum request body size the server will accept (1 MiB) */
const MAX_INPUT_SIZE = 1_048_576;

/** Minimum interval between requests from the same "session" (ms) */
const RATE_LIMIT_WINDOW_MS = 100;

/** Maps a coarse session key to the last request timestamp */
const rateLimitMap = new Map<string, number>();

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

function checkRateLimit(): McpErrorResult | null {
  // Coarse in-process rate limiter: use an ephemeral session key
  // (In production an MCP server would use transport-scoped identifiers.)
  const key = "default";
  const last = rateLimitMap.get(key) ?? 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_WINDOW_MS) {
    return makeError(
      ErrorCode.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded. Minimum ${RATE_LIMIT_WINDOW_MS}ms between requests.`,
      { retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - last) },
    );
  }
  rateLimitMap.set(key, now);
  return null;
}

// ─── Server Setup ─────────────────────────────────────────────

const server = new Server(
  {
    name: "playbooks-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ─── Tool Definitions ────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health_check",
        description:
          "Health check / readiness probe. Returns the server status including uptime, active runs count, and search paths. Use this to verify the MCP server is operational before issuing other commands.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_playbooks",
        description:
          "Discover all available playbooks with names, descriptions, parameters, and tags. Playbooks are declarative, versioned, multi-step AI workflows encoded as YAML+Markdown files. Use this to explore what workflows are available before running one.",
        inputSchema: {
          type: "object",
          properties: {
            tag: {
              type: "string",
              description: "Optional tag to filter playbooks by",
            },
          },
        },
      },
      {
        name: "run_playbook",
        description:
          "Start executing a multi-step playbook workflow. Returns the first step's system prompt, resolved step prompt, and gate information. The agent should complete the step and then call complete_step or skip_step. Each run is assigned a unique runId that must be used in subsequent step-control calls.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Name of the playbook to execute (e.g., 'commit', 'release', 'incident-response')",
            },
            params: {
              type: "object",
              description:
                "Typed parameters for the playbook. Each playbook defines its own parameters with types (String, Number, Boolean, Array), defaults, and validation rules. Unknown or mistyped parameters will be rejected.",
              additionalProperties: true,
            },
          },
          required: ["name"],
        },
      },
      {
        name: "complete_step",
        description:
          "Mark the current playbook step as completed and advance to the next step. Returns the next step's context if there are more steps, or indicates the run is finished. Pass the optional output parameter to store a named value for downstream steps (referenced via {{state.key}}).",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID returned by run_playbook",
            },
            output: {
              type: "string",
              description:
                "Optional output from the completed step. If the step defines a named output key in its YAML, this value will be stored for use by downstream steps via {{state.key}} in templates.",
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "skip_step",
        description:
          "Skip the current playbook step and advance to the next one. Useful for optional steps, conditional branches, or when a step is not applicable to the current context.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID returned by run_playbook",
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "fail_step",
        description:
          "Mark the current playbook step as failed. The playbook run will be terminated with a failure status. The run cannot be resumed after failure unless the step has auto_retry enabled.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID returned by run_playbook",
            },
            error: {
              type: "string",
              description: "Description of what went wrong (included in run state and logs)",
            },
          },
          required: ["runId", "error"],
        },
      },
      {
        name: "resume_playbook",
        description:
          "Resume a playbook that was interrupted (e.g., agent restart, connection loss). Restores state from the last checkpoint on disk and returns the current step context. Only works for runs that were in progress when the interruption occurred.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID to resume",
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "get_playbook_state",
        description:
          "Get the full current state of a playbook run: which step is active, step completion status, named outputs stored via {{state.*}}, parameters, and run metadata. Works for both active and completed runs.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID to inspect",
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "validate_playbook",
        description:
          "Validate a playbook's syntax, parameter definitions, and step structure. Use this during playbook development or before executing an unfamiliar playbook. Returns a list of issues with severity levels.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the playbook to validate",
            },
            params: {
              type: "object",
              description:
                "Optional parameters to validate against the playbook's parameter definitions",
              additionalProperties: true,
            },
          },
          required: ["name"],
        },
      },
      {
        name: "acknowledge_gate",
        description:
          "Acknowledge a human-in-the-loop gate on a paused playbook step. Gates (Confirm, Review, Approve) require explicit acknowledgment before the step can be marked complete and the run can advance. Call this after presenting the step's output for human review.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID of the paused playbook",
            },
            output: {
              type: "string",
              description:
                "Optional output from the acknowledged step. If the step defines a named output key, this value is stored for downstream use via {{state.key}}.",
            },
          },
          required: ["runId"],
        },
      },
    ],
  };
});

// ─── Tool Handler ─────────────────────────────────────────────

const serverStartTime = Date.now();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── Rate limiting ───────────────────────────────────────────
  // health_check bypasses rate limiting
  if (name !== "health_check") {
    const rateErr = checkRateLimit();
    if (rateErr) return createErrorResult(rateErr);
  }

  // ── Input size guard ────────────────────────────────────────
  const sizeErr = checkInputSize(name, args as Record<string, unknown> | undefined);
  if (sizeErr) return createErrorResult(sizeErr);

  try {
    switch (name) {
      case "health_check": {
        let searchPaths: string[] = [];
        try {
          searchPaths = resolveSearchPaths();
        } catch {
          // ignore — return empty list if discovery fails
        }
        const uptimeSec = Math.floor((Date.now() - serverStartTime) / 1000);
        // Count persisted runs on disk for a rough active-count metric
        let persistedRuns = 0;
        try {
          const stateDir = path.join(
            process.env.HOME ?? process.env.USERPROFILE ?? "",
            ".openmono",
            "state",
          );
          if (fs.existsSync(stateDir)) {
            persistedRuns = fs
              .readdirSync(stateDir)
              .filter((f: string) => f.endsWith(".json")).length;
          }
        } catch {
          // ignore
        }
        return createTextResult(
          [
            "## 🟢 Server Healthy",
            "",
            `- **Status:** running`,
            `- **Uptime:** ${uptimeSec}s`,
            `- **Persisted runs on disk:** ${persistedRuns}`,
            `- **Search paths:** ${searchPaths.length > 0 ? searchPaths.join(", ") : "(none found)"}`,
            `- **Version:** 1.0.0`,
          ].join("\n"),
        );
      }

      case "list_playbooks": {
        const tag = args?.tag as string | undefined;
        const playbooks = listPlaybooks(tag);
        return createTextResult(
          playbooks.length === 0
            ? "No playbooks found. Create a `.openmono/playbooks/<name>/PLAYBOOK.md` file to define one."
            : formatPlaybookList(playbooks),
        );
      }

      case "run_playbook": {
        const pbName = args?.name as string;
        const params = (args?.params as Record<string, unknown>) ?? {};
        const result = await startRun(pbName, params);

        if (result.error) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        const ctx = getCurrentStepContext(result.run);
        if (!ctx) {
          return createTextResult(
            `✅ Playbook "${pbName}" has no steps. Run complete.\n\nRun ID: ${result.run.runId}\nStatus: completed`,
          );
        }

        return createTextResult(formatStepContext(result.run.runId, ctx));
      }

      case "complete_step": {
        const runId = args?.runId as string;
        const output = args?.output as string | undefined;
        const result = await completeCurrentStep(runId, output);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (result.run.status === "completed") {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" completed successfully!\n\nRun ID: ${runId}\nSteps completed: ${result.run.totalSteps}\n\n## Final State\n\`\`\`json\n${JSON.stringify({ params: result.run.params, state: result.run.state, stepResults: result.run.stepResults }, null, 2)}\n\`\`\``,
          );
        }

        if (result.run.status === "failed") {
          return createTextResult(
            `❌ Playbook "${result.run.playbookName}" failed: ${result.run.error}`,
            true,
          );
        }

        if (result.nextStepContext) {
          return createTextResult(formatStepContext(runId, result.nextStepContext));
        }

        return createTextResult(`⚠️ Unexpected state after step completion. Run ID: ${runId}`);
      }

      case "skip_step": {
        const runId = args?.runId as string;
        const result = await skipCurrentStep(runId);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (result.run.status === "completed") {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" completed (last step skipped).\n\nRun ID: ${runId}`,
          );
        }

        if (result.nextStepContext) {
          return createTextResult(formatStepContext(runId, result.nextStepContext));
        }

        return createTextResult(`⚠️ Unexpected state after skipping step. Run ID: ${runId}`);
      }

      case "fail_step": {
        const runId = args?.runId as string;
        const error = args?.error as string;
        const result = await completeCurrentStep(runId, undefined, error);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        return createTextResult(
          `❌ Playbook step failed. Run "${result.run.playbookName}" terminated.\n\nError: ${error}\nRun ID: ${runId}`,
          true,
        );
      }

      case "resume_playbook": {
        const runId = args?.runId as string;
        const result = await resumeRun(runId);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (!result.stepContext) {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" already completed.\n\nRun ID: ${runId}`,
          );
        }

        return createTextResult(formatStepContext(runId, result.stepContext));
      }

      case "get_playbook_state": {
        const runId = args?.runId as string;
        const result = getRunState(runId);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        return createTextResult(
          `## Playbook Run State: ${result.playbookName}\n\n` +
            `- **Run ID:** ${result.runId}\n` +
            `- **Version:** ${result.playbookVersion}\n` +
            `- **Status:** ${result.status}\n` +
            `- **Progress:** ${result.currentStepIndex}/${result.totalSteps} steps\n` +
            `- **Started:** ${result.startedAt}\n` +
            `- **Finished:** ${result.finishedAt ?? "—"}\n\n` +
            `### Parameters\n\`\`\`json\n${JSON.stringify(result.params, null, 2)}\n\`\`\`\n\n` +
            `### State (named outputs)\n\`\`\`json\n${JSON.stringify(result.state, null, 2)}\n\`\`\`\n\n` +
            `### Steps\n\`\`\`json\n${JSON.stringify(result.stepResults, null, 2)}\n\`\`\``,
        );
      }

      case "validate_playbook": {
        const pbName = args?.name as string;
        const params = args?.params as Record<string, unknown> | undefined;
        const result = runValidate(pbName, params);

        if (result.valid) {
          return createTextResult(`✅ Playbook "${pbName}" is valid. No issues found.`);
        }

        const lines: string[] = [`⚠️ Playbook "${pbName}" has issues:\n`];
        for (const issue of result.issues) {
          const icon = issue.severity === "error" ? "🔴" : "🟡";
          lines.push(`- ${icon} [${issue.severity}] ${issue.field}: ${issue.message}`);
        }
        if (result.paramErrors && result.paramErrors.length > 0) {
          lines.push("\n### Parameter Errors:");
          for (const pe of result.paramErrors) {
            lines.push(`- 🔴 ${pe}`);
          }
        }
        return createTextResult(lines.join("\n"));
      }

      case "acknowledge_gate": {
        const runId = args?.runId as string;
        const output = args?.output as string | undefined;
        const result = await acknowledgeGate(runId, output);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (result.run.status === "completed") {
          return createTextResult(
            `✅ Gate acknowledged. Playbook "${result.run.playbookName}" completed successfully!\n\nRun ID: ${runId}`,
          );
        }

        if (result.nextStepContext) {
          return createTextResult(formatStepContext(runId, result.nextStepContext));
        }

        return createTextResult(`✅ Gate acknowledged. Run ${runId} advanced.`);
      }

      case "match_playbook": {
        const input = args?.input as string;
        if (!input || input.trim().length === 0) {
          return createTextResult("Please provide an `input` string to match against.", true);
        }

        const allPlaybooks = discoverPlaybooks();
        const matches = matchTrigger(input, allPlaybooks);

        if (matches.length === 0) {
          return createTextResult(
            `No playbook matches "${input}". Use \`list_playbooks\` to see all available playbooks.`,
          );
        }

        const lines: string[] = [
          `## Matching Playbooks for "${input}" (${matches.length} found)\n`,
        ];
        for (const m of matches) {
          const tags = m.playbook.tags?.length ? ` [${m.playbook.tags.join(", ")}]` : "";
          lines.push(
            `- **${m.playbook.name}**${tags} v${m.playbook.version} — score: ${m.score} (pattern: \`${m.matchedPattern}\`)`,
          );
          lines.push(`  ${m.playbook.description}`);
        }
        return createTextResult(lines.join("\n"));
      }

      default:
        return createTextResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    logger.error("index", "Unhandled error in tool handler", {
      tool: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return createErrorResult(
      makeError(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err)),
    );
  }
});

// ─── Formatting Helpers ───────────────────────────────────────

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

function formatPlaybookList(
  playbooks: {
    name: string;
    version: string;
    description: string;
    tags?: string[];
    trigger: string;
    argumentHint?: string;
  }[],
): string {
  const lines: string[] = [`## Available Playbooks (${playbooks.length})\n`];
  for (const p of playbooks) {
    const tags = p.tags && p.tags.length > 0 ? ` [${p.tags.join(", ")}]` : "";
    const trigger = p.trigger !== "manual" ? ` (trigger: ${p.trigger})` : "";
    const hint = p.argumentHint ? ` — ${p.argumentHint}` : "";
    lines.push(`- **${p.name}**${tags} v${p.version}${trigger}${hint}\n  ${p.description}`);
  }
  return lines.join("\n");
}

function formatStepContext(
  runId: string,
  ctx: NonNullable<ReturnType<typeof getCurrentStepContext>>,
): string {
  const lines: string[] = [
    `## 📋 Playbook Step: ${ctx.step.id}`,
    `- **Run ID:** ${runId}`,
    `- **Step:** ${ctx.stepIndex + 1}`,
    `- **Description:** ${ctx.step.description ?? "—"}`,
  ];

  if (ctx.gate) {
    lines.push(`- **Gate:** 🚪 ${ctx.gate} (requires human acknowledgment before proceeding)`);
  }

  lines.push(
    "",
    "### System Prompt",
    "```",
    ctx.systemPrompt,
    "```",
    "",
    "### Step Prompt",
    "```",
    ctx.resolvedPrompt,
    "```",
    "",
    `### Allowed Tools: ${ctx.allowedTools.join(", ")}`,
    "",
    "---",
    "",
    "**Instructions for the agent:**",
    "1. Execute the **Step Prompt** above using the available tools",
    "2. When the step is done, call `complete_step` with the run ID and optional output",
    "3. If this step should be skipped, call `skip_step` with the run ID",
    "4. If something goes wrong, call `fail_step` with the run ID and an error description",
  );

  if (ctx.gate) {
    lines.push(
      "",
      `⚠️ **Gate Active:** This step requires **${ctx.gate}** approval before proceeding. The step result should be presented for human review.`,
    );
  }

  return lines.join("\n");
}

// ─── Start Server ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("index", "Server started via stdio", {});
  logger.info("index", "Search paths configured", {
    paths: process.env.PLAYBOOKS_PATH || "~/.openmono/playbooks, ./.openmono/playbooks",
  });
}

main().catch((err) => {
  logger.error("index", "Fatal error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
