#!/usr/bin/env node

/**
 * OpenMono Playbooks MCP Server
 *
 * Exposes the OpenMono Playbooks workflow orchestration engine
 * to any MCP-compatible agent (Claude Desktop, Cline, Continue, etc.).
 *
 * This server makes playbooks accessible as first-class tools:
 *   - list_playbooks     — Discover available playbooks
 *   - run_playbook       — Execute a playbook with typed parameters
 *   - resume_playbook    — Resume an interrupted playbook
 *   - get_playbook_state — Inspect run state
 *   - validate_playbook  — Validate syntax and parameters
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

import {
  listPlaybooks,
  startRun,
  completeCurrentStep,
  skipCurrentStep,
  resumeRun,
  getRunState,
  runValidate,
  getCurrentStepContext,
} from "./executor.js";

// ─── Server Setup ─────────────────────────────────────────────

const server = new Server(
  {
    name: "openmono-playbooks-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Definitions ────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_playbooks",
        description:
          "Discover all available playbooks with names, descriptions, parameters, and tags. Playbooks are declarative, versioned, multi-step AI workflows encoded as YAML+Markdown files.",
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
          "Start executing a multi-step playbook workflow. Returns the first step's system prompt, resolved step prompt, and gate information. The agent should complete the step and then call complete_step or skip_step.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the playbook to execute (e.g., 'commit', 'release', 'incident-response')",
            },
            params: {
              type: "object",
              description:
                "Typed parameters for the playbook. Each playbook defines its own parameters with types, defaults, and validation rules.",
              additionalProperties: true,
            },
          },
          required: ["name"],
        },
      },
      {
        name: "complete_step",
        description:
          "Mark the current playbook step as completed and advance to the next step. Returns the next step's context if there are more steps, or indicates the run is finished.",
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
                "Optional output from the completed step. If the step defines a named output key, this value will be stored for use by downstream steps via {{state.key}}.",
            },
          },
          required: ["runId"],
        },
      },
      {
        name: "skip_step",
        description:
          "Skip the current playbook step and advance to the next one. Useful for optional steps or when a step is not applicable.",
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
          "Mark the current playbook step as failed. The playbook run will be terminated with a failure status.",
        inputSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "The run ID returned by run_playbook",
            },
            error: {
              type: "string",
              description: "Description of what went wrong",
            },
          },
          required: ["runId", "error"],
        },
      },
      {
        name: "resume_playbook",
        description:
          "Resume a playbook that was interrupted (e.g., agent restart, connection loss). Restores from the last checkpoint and returns the current step context.",
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
          "Get the full current state of a playbook run: which step is active, step completion status, named outputs, parameters, and run metadata.",
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
          "Validate a playbook's syntax, parameter definitions, and step structure. Use this to check a playbook before executing it or during development.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the playbook to validate",
            },
            params: {
              type: "object",
              description: "Optional parameters to validate against the playbook's parameter definitions",
              additionalProperties: true,
            },
          },
          required: ["name"],
        },
      },
    ],
  };
});

// ─── Tool Handler ─────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_playbooks": {
        const tag = args?.tag as string | undefined;
        const playbooks = listPlaybooks(tag);
        return createTextResult(
          playbooks.length === 0
            ? "No playbooks found. Create a `.openmono/playbooks/<name>/PLAYBOOK.md` file to define one."
            : formatPlaybookList(playbooks)
        );
      }

      case "run_playbook": {
        const pbName = args?.name as string;
        const params = (args?.params as Record<string, unknown>) ?? {};
        const result = startRun(pbName, params);

        if (result.error) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        const ctx = getCurrentStepContext(result.run);
        if (!ctx) {
          return createTextResult(
            `✅ Playbook "${pbName}" has no steps. Run complete.\n\nRun ID: ${result.run.runId}\nStatus: completed`
          );
        }

        return createTextResult(formatStepContext(result.run.runId, ctx));
      }

      case "complete_step": {
        const runId = args?.runId as string;
        const output = args?.output as string | undefined;
        const result = completeCurrentStep(runId, output);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (result.run.status === "completed") {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" completed successfully!\n\nRun ID: ${runId}\nSteps completed: ${result.run.totalSteps}\n\n## Final State\n\`\`\`json\n${JSON.stringify({ params: result.run.params, state: result.run.state, stepResults: result.run.stepResults }, null, 2)}\n\`\`\``
          );
        }

        if (result.run.status === "failed") {
          return createTextResult(
            `❌ Playbook "${result.run.playbookName}" failed: ${result.run.error}`,
            true
          );
        }

        if (result.nextStepContext) {
          return createTextResult(formatStepContext(runId, result.nextStepContext));
        }

        return createTextResult(
          `⚠️ Unexpected state after step completion. Run ID: ${runId}`
        );
      }

      case "skip_step": {
        const runId = args?.runId as string;
        const result = skipCurrentStep(runId);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (result.run.status === "completed") {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" completed (last step skipped).\n\nRun ID: ${runId}`
          );
        }

        if (result.nextStepContext) {
          return createTextResult(formatStepContext(runId, result.nextStepContext));
        }

        return createTextResult(
          `⚠️ Unexpected state after skipping step. Run ID: ${runId}`
        );
      }

      case "fail_step": {
        const runId = args?.runId as string;
        const error = args?.error as string;
        const result = completeCurrentStep(runId, undefined, error);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        return createTextResult(
          `❌ Playbook step failed. Run "${result.run.playbookName}" terminated.\n\nError: ${error}\nRun ID: ${runId}`,
          true
        );
      }

      case "resume_playbook": {
        const runId = args?.runId as string;
        const result = resumeRun(runId);

        if ("error" in result) {
          return createTextResult(`❌ ${result.error}`, true);
        }

        if (!result.stepContext) {
          return createTextResult(
            `✅ Playbook "${result.run.playbookName}" already completed.\n\nRun ID: ${runId}`
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
            `### Steps\n\`\`\`json\n${JSON.stringify(result.stepResults, null, 2)}\n\`\`\``
        );
      }

      case "validate_playbook": {
        const pbName = args?.name as string;
        const params = args?.params as Record<string, unknown> | undefined;
        const result = runValidate(pbName, params);

        if (result.valid) {
          return createTextResult(
            `✅ Playbook "${pbName}" is valid. No issues found.`
          );
        }

        const lines: string[] = [
          `⚠️ Playbook "${pbName}" has issues:\n`,
        ];
        for (const issue of result.issues) {
          const icon = issue.severity === "error" ? "🔴" : "🟡";
          lines.push(
            `- ${icon} [${issue.severity}] ${issue.field}: ${issue.message}`
          );
        }
        if (result.paramErrors && result.paramErrors.length > 0) {
          lines.push("\n### Parameter Errors:");
          for (const pe of result.paramErrors) {
            lines.push(`- 🔴 ${pe}`);
          }
        }
        return createTextResult(lines.join("\n"));
      }

      default:
        return createTextResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    return createTextResult(
      `❌ Internal error: ${err instanceof Error ? err.message : String(err)}`,
      true
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

function formatPlaybookList(
  playbooks: { name: string; version: string; description: string; tags?: string[]; trigger: string; argumentHint?: string }[]
): string {
  const lines: string[] = [
    `## Available Playbooks (${playbooks.length})\n`,
  ];
  for (const p of playbooks) {
    const tags = p.tags && p.tags.length > 0 ? ` [${p.tags.join(", ")}]` : "";
    const trigger = p.trigger !== "manual" ? ` (trigger: ${p.trigger})` : "";
    const hint = p.argumentHint ? ` — ${p.argumentHint}` : "";
    lines.push(
      `- **${p.name}**${tags} v${p.version}${trigger}${hint}\n  ${p.description}`
    );
  }
  return lines.join("\n");
}

function formatStepContext(
  runId: string,
  ctx: NonNullable<ReturnType<typeof getCurrentStepContext>>
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
      `⚠️ **Gate Active:** This step requires **${ctx.gate}** approval before proceeding. The step result should be presented for human review.`
    );
  }

  return lines.join("\n");
}

// ─── Start Server ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[openmono-playbooks-mcp] Server started via stdio");
  console.error("[openmono-playbooks-mcp] Search paths:", process.env.PLAYBOOKS_PATH || "~/.openmono/playbooks, ./.openmono/playbooks");
}

main().catch((err) => {
  console.error("[openmono-playbooks-mcp] Fatal error:", err);
  process.exit(1);
});