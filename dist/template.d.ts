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
export declare function resolveTemplate(text: string, ctx: TemplateContext): string;
/**
 * Resolves all template variables in a playbook body.
 * Used before sending the system prompt to the LLM.
 */
export declare function resolvePlaybookBody(body: string, ctx: TemplateContext): string;
/**
 * Resolves a step's prompt (from file or inline) with template variables.
 */
export declare function resolveStepPrompt(text: string, ctx: TemplateContext): string;
/**
 * Formats constraints into a text block for injection into context.
 */
export declare function formatConstraints(constraints: {
    rule: string;
    severity?: string;
    reason?: string;
}[]): string;
