#!/usr/bin/env node

/**
 * OpenMono Playbooks MCP Server
 *
 * Exposes the OpenMono Playbooks workflow orchestration engine
 * to any MCP-compatible agent (Claude Desktop, Cline, Continue, etc.).
 *
 * This server makes playbooks accessible as first-class tools:
 *   - health_check        — Server readiness probe                   [read-only]
 *   - list_playbooks      — Discover available playbooks             [read-only]
 *   - match_playbook      — Match user input to trigger patterns     [read-only]
 *   - validate_playbook   — Validate syntax and parameters           [read-only]
 *   - get_playbook_state  — Inspect run state                        [read-only]
 *   - run_playbook        — Execute a playbook with typed parameters [stateful]
 *   - resume_playbook     — Resume an interrupted playbook           [stateful]
 *   - complete_step       — Advance playbook to the next step        [stateful]
 *   - skip_step           — Skip current step and advance            [stateful]
 *   - fail_step           — Terminate playbook with failure          [destructive]
 *   - acknowledge_gate    — Acknowledge a human-in-the-loop gate     [stateful]
 *
 * Inspired by and derived from OpenMonoAgent.ai by StartupHakk.
 * See: https://github.com/StartupHakk/OpenMonoAgent.ai
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import * as fs from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json at startup so it stays in sync with releases
const pkgPath = path.resolve(__dirname, "..", "package.json");
const SERVER_VERSION: string = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;

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

// ─── Input Guards ────────────────────────────────────────────

/** Maximum request body size the server will accept (1 MiB) */
const MAX_INPUT_SIZE = 1_048_576;

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

// ─── Server Setup ─────────────────────────────────────────────

// Resolve the absolute path to the extension logo for the MCP icons capability.
// VS Code uses file:// URIs to display icons for stdio-transport MCP servers
// in the agent mode tool picker.
const logoPath = path.resolve(__dirname, "..", "logo.png");
const logoUri = `file:///${logoPath.replace(/\\/g, "/")}`;

const server = new Server(
  {
    name: "playbooks-mcp",
    version: SERVER_VERSION,
    icons: [
      {
        src: logoUri,
        mimeType: "image/png",
        sizes: ["512x512"],
      },
    ],
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: [
      "You are connected to the Playbooks MCP server, which orchestrates typed, multi-step AI",
      "workflows (playbooks) with human-in-the-loop gates and checkpoint/resume.",
      "",
      "## Mandatory Agent Protocol",
      "",
      "### On every user turn (BEFORE responding)",
      "1. Call `match_playbook` with the user's raw input.",
      "   - If a match is returned (score >= 1), call `run_playbook` with that playbook name.",
      "   - Do NOT respond to the user directly when a playbook matches — execute it instead.",
      "   - If no match: respond normally.",
      "",
      "### During a playbook run",
      "2. After completing the work described in each step prompt, ALWAYS call `complete_step`.",
      "   Never leave a step open. Do not skip this even if the step seems trivial.",
      "3. If a step cannot be completed, call `fail_step` with a clear error description.",
      "4. To skip an optional step, call `skip_step`.",
      "",
      "### At gates (Confirm / Review / Approve)",
      "5. Complete the step work first, present the output to the user, then call `acknowledge_gate`.",
      "   The run will NOT advance until the gate is acknowledged.",
      "",
      "### Session start",
      "6. Call `health_check` once to verify the server is ready.",
      "7. Call `list_playbooks` to load available workflows into context.",
      "",
      "## Tool Lifecycle",
      "",
      "match_playbook → run_playbook → [complete_step | skip_step | fail_step]",
      "                                → acknowledge_gate (at gates) → repeat until done",
      "",
      "NEVER read a PLAYBOOK.md file directly. Always use `run_playbook` to execute workflows.",
      "Use `resume_playbook` if the agent restarts mid-run.",
    ].join("\n"),
  },
);

// ─── Tool Definitions ────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health_check",
        description:
          "Health check / readiness probe. Returns the server status including uptime, active runs count, and search paths. Use this to verify the MCP server is operational before issuing other commands. Read-only — does not modify any state.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_playbooks",
        description:
          "Discover all available playbooks with names, descriptions, parameters, and tags. Playbooks are declarative, versioned, multi-step AI workflows encoded as YAML+Markdown files. Use this to explore what workflows are available before running one. Read-only — does not modify any state.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
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
        name: "match_playbook",
        description:
          "Match a natural-language query against all available playbooks using trigger-pattern matching. Returns playbooks sorted by relevance score. Call this on EVERY user turn before responding — if a match is found, call run_playbook instead of replying directly. Read-only — does not modify any state.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Natural-language query to match against playbook trigger patterns (e.g., 'commit', 'deploy to staging')",
            },
          },
          required: ["input"],
        },
      },
      {
        name: "run_playbook",
        description:
          "Start executing a multi-step playbook workflow. Returns the first step's system prompt, resolved step prompt, and gate information. The agent should complete the step and then call complete_step or skip_step. Each run is assigned a unique runId that must be used in subsequent step-control calls. Creates persistent run state on disk.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
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
          "Mark the current playbook step as completed and advance to the next step. Returns the next step's context if there are more steps, or indicates the run is finished. Pass the optional output parameter to store a named value for downstream steps (referenced via {{state.key}}). Advances persistent run state — cannot be undone.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
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
          "Skip the current playbook step and advance to the next one. Useful for optional steps, conditional branches, or when a step is not applicable to the current context. Advances persistent run state — cannot be undone.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
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
          "Mark the current playbook step as failed and permanently terminate the run. The playbook run will be terminated with a failure status and cannot be resumed. Use only when the step cannot be completed and the workflow must be abandoned.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
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
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
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
          "Get the full current state of a playbook run: which step is active, step completion status, named outputs stored via {{state.*}}, parameters, and run metadata. Works for both active and completed runs. Read-only — does not modify any state.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
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
          "Validate a playbook's syntax, parameter definitions, and step structure without executing it. Use this during playbook development or before executing an unfamiliar playbook. Returns a list of issues with severity levels. Read-only — does not create a run or modify any state.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
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
          "Acknowledge a human-in-the-loop gate on a paused playbook step. Gates (Confirm, Review, Approve) require explicit acknowledgment before the step can be marked complete and the run can advance. Call this after presenting the step's output for human review. Advances persistent run state — cannot be undone.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
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

// ─── Prompt Definitions ───────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const playbooks = discoverPlaybooks().filter(
    (p) => p["user-invocable"] !== false,
  );

  const prompts = playbooks.map((p) => {
    const args = Object.entries(p.parameters ?? {}).map(([paramName, param]) => ({
      name: paramName,
      description: param.hint ?? `${param.type} parameter`,
      required: param.required === true,
    }));

    return {
      name: p.name,
      title: p.name,
      description: p.description,
      arguments: args.length > 0 ? args : undefined,
    };
  });

  return { prompts };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;
  const playbooks = discoverPlaybooks();
  const playbook = playbooks.find((p) => p.name === name);

  if (!playbook) {
    throw new Error(`Playbook "${name}" not found`);
  }

  const paramLines = Object.entries(playbook.parameters ?? {})
    .map(([k, param]) => {
      const supplied = promptArgs?.[k];
      const value = supplied ?? (param.default !== undefined ? String(param.default) : "<required>");
      return `  ${k}: ${value}  # ${param.hint ?? param.type}`;
    })
    .join("\n");

  const hint = playbook["argument-hint"] ?? "";
  const userMessage = [
    `Please run the \`${name}\` playbook.`,
    hint ? `Usage: \`run_playbook ${name} ${hint}\`` : "",
    "",
    "Call `run_playbook` now with:",
    "```",
    `name: ${name}`,
    paramLines ? `params:\n${paramLines}` : "params: {}",
    "```",
    "",
    "After each step completes, call `complete_step`. Acknowledge gates with `acknowledge_gate`.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  return {
    description: playbook.description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: userMessage },
      },
    ],
  };
});

// ─── Tool Handler ─────────────────────────────────────────────

const serverStartTime = Date.now();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
            `- **Version:** ${SERVER_VERSION}`,
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
        lines.push(
          "",
          "---",
          "",
          "> **🔔 NEXT STEP:** To execute the best match, call `run_playbook` with the playbook name.",
          "> Do NOT read the PLAYBOOK.md file — call `run_playbook` to execute the workflow properly.",
        );
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
  const lines: string[] = [
    `## Available Playbooks (${playbooks.length})\n`,
    "> **🔔 PROTOCOL:** To execute a playbook, call `run_playbook` with its name and parameters. " +
    "Do NOT read the PLAYBOOK.md file directly — it is a workflow to be executed, not documentation.\n",
  ];
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
    "---",
    "",
    "# ⚠️ PLAYBOOK PROTOCOL — MANDATORY",
    "",
    `**Run ID:** \`${runId}\`  `,
    "**You are now executing a playbook step. After completing the instructions below, you MUST call `complete_step` to advance.**",
    "",
    `→ When done: call **complete_step** with runId: \`"${runId}"\` and optional output`,
    `→ To skip: call **skip_step** with runId: \`"${runId}"\``,
    `→ On failure: call **fail_step** with runId: \`"${runId}"\` and an error description`,
    "",
    "Do NOT just read the prompt and move on — execute it, then call complete_step.",
    "",
    "---",
    "",
    `## 📋 Step: ${ctx.step.id} (${ctx.stepIndex + 1})`,
    `- **Description:** ${ctx.step.description ?? "—"}`,
  ];

  if (ctx.step.agent) {
    lines.push(`- **🤖 Sub-Agent:** \`${ctx.step.agent}\` — delegate this step to the named agent`);
  }

  if (ctx.gate) {
    lines.push(
      "",
      `🚪 **GATE ACTIVE: ${ctx.gate}**`,
      `This step requires human ${ctx.gate.toLowerCase()} before it can proceed.`,
      "1. Execute the step prompt below",
      "2. Present the output for human review",
      `3. Call **acknowledge_gate** with runId: \`"${runId}"\` to proceed`,
      "",
      "⚠️ The step will NOT complete until the gate is acknowledged.",
    );
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
    `🔁 **REMINDER:** When you finish this step, call **complete_step** with runId: \`"${runId}"\``,
  );

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
