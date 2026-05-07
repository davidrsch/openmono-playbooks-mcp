/**
 * Template Variable Engine
 *
 * Resolves playbook template variables:
 *   {{params.<name>}}  — Resolved at invocation time
 *   {{state.<key>}}    — Resolved during step execution
 *   {{shell:<cmd>}}    — Resolved to stdout of a shell command
 *   {{file:<path>}}    — Resolved to file contents
 *   {{env.<name>}}     — Resolved to environment variable
 *   {{constraints}}    — Resolved to constraint text block
 *
 * Mirrors the template resolution in OpenMonoAgent.ai's TemplateEngine.cs.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { PlaybookRunState } from "./types.js";

/**
 * Template resolution context passed during step execution.
 */
export interface TemplateContext {
  /** Parameters supplied when the playbook was invoked */
  params: Record<string, unknown>;
  /** Named step outputs (state) accumulated so far */
  state: Record<string, string>;
  /** Resolved constraint text (from constraints block or file) */
  constraints: string;
  /** Base directory for file: template resolution (the playbook directory) */
  baseDir: string;
}

/**
 * Resolves all template variables in a string.
 * Variables are of the form {{type.name}} or {{type:value}}.
 */
export function resolveTemplate(
  text: string,
  ctx: TemplateContext
): string {
  return text.replace(
    /\{\{(params|state|shell|file|env|constraints)\.?([^}]*)\}\}/g,
    (match, type: string, key: string) => {
      return resolveSingleVariable(type, key.trim(), ctx) ?? match;
    }
  );
}

function resolveSingleVariable(
  type: string,
  key: string,
  ctx: TemplateContext
): string | null {
  switch (type) {
    case "params": {
      if (key in ctx.params) {
        const val = ctx.params[key];
        if (Array.isArray(val)) return val.join(", ");
        return String(val ?? "");
      }
      return `{{params.${key}}}`; // Leave unresolved for agent awareness
    }

    case "state": {
      if (key in ctx.state) {
        return ctx.state[key];
      }
      return `{{state.${key}}}`;
    }

    case "shell": {
      try {
        const result = execSync(key, {
          encoding: "utf-8",
          timeout: 10_000,
          windowsHide: true,
        });
        return result.trimEnd();
      } catch {
        return `{{shell:${key}}}`;
      }
    }

    case "file": {
      try {
        const filePath = isAbsolute(key)
          ? key
          : resolve(ctx.baseDir, key);
        if (existsSync(filePath)) {
          return readFileSync(filePath, "utf-8").trim();
        }
      } catch {
        // Fall through
      }
      return `{{file:${key}}}`;
    }

    case "env": {
      return process.env[key] ?? `{{env.${key}}}`;
    }

    case "constraints": {
      return ctx.constraints;
    }

    default:
      return null;
  }
}

/**
 * Resolves all template variables in a playbook body.
 * Used before sending the system prompt to the LLM.
 */
export function resolvePlaybookBody(
  body: string,
  ctx: TemplateContext
): string {
  return resolveTemplate(body, ctx);
}

/**
 * Resolves a step's prompt (from file or inline) with template variables.
 */
export function resolveStepPrompt(
  text: string,
  ctx: TemplateContext
): string {
  return resolveTemplate(text, ctx);
}

/**
 * Formats constraints into a text block for injection into context.
 */
export function formatConstraints(
  constraints: { rule: string; severity?: string; reason?: string }[]
): string {
  if (!constraints || constraints.length === 0) return "";

  const lines = ["## Constraints / Safety Guardrails", ""];
  for (const c of constraints) {
    const prefix = c.severity === "error" ? "🔴 MUST" : "🟡 SHOULD";
    lines.push(`- **${prefix}:** ${c.rule}`);
    if (c.reason) {
      lines.push(`  *Reason:* ${c.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}