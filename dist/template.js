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
/**
 * Resolves all template variables in a string.
 * Variables are of the form {{type.name}} or {{type:value}}.
 */
export function resolveTemplate(text, ctx) {
    return text.replace(/\{\{(params|state|shell|file|env|constraints)[.:]?([^}]*)\}\}/g, (match, type, key) => {
        return resolveSingleVariable(type, key.trim(), ctx) ?? match;
    });
}
function resolveSingleVariable(type, key, ctx) {
    switch (type) {
        case "params": {
            if (key in ctx.params) {
                const val = ctx.params[key];
                if (Array.isArray(val))
                    return val.join(", ");
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
            }
            catch {
                return `{{shell:${key}}}`;
            }
        }
        case "file": {
            try {
                const filePath = isAbsolute(key) ? key : resolve(ctx.baseDir, key);
                if (existsSync(filePath)) {
                    return readFileSync(filePath, "utf-8").trim();
                }
            }
            catch {
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
export function resolvePlaybookBody(body, ctx) {
    return resolveTemplate(body, ctx);
}
/**
 * Resolves a step's prompt (from file or inline) with template variables.
 */
export function resolveStepPrompt(text, ctx) {
    return resolveTemplate(text, ctx);
}
/**
 * Formats constraints into a text block for injection into context.
 */
export function formatConstraints(constraints) {
    if (!constraints || constraints.length === 0)
        return "";
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
//# sourceMappingURL=template.js.map