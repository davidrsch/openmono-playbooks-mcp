/**
 * Playbook Loader
 *
 * Discovers, parses, and validates PLAYBOOK.md files from the filesystem.
 * Mirrors the discovery logic from OpenMonoAgent.ai's PlaybookLoader.cs
 * and PlaybookRegistry.cs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
// ─── Constants ────────────────────────────────────────────────
const PLAYBOOK_FILENAME = "PLAYBOOK.md";
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n([\s\S]*)$/;
// ─── Search Path Resolution ──────────────────────────────────
/**
 * Resolves the ordered list of directories to search for playbooks.
 * Order: PLAYBOOKS_PATH env var, ~/.openmono/playbooks, .openmono/playbooks
 */
export function resolveSearchPaths() {
    const paths = [];
    // 1. Explicit env var overrides everything
    const envPath = process.env.PLAYBOOKS_PATH;
    if (envPath) {
        for (const p of envPath.split(path.delimiter)) {
            const resolved = p.startsWith("~")
                ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", p.slice(1))
                : p;
            if (fs.existsSync(resolved))
                paths.push(resolved);
        }
    }
    // 2. User-global playbooks
    const homePlaybooks = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".openmono", "playbooks");
    if (fs.existsSync(homePlaybooks))
        paths.push(homePlaybooks);
    // 3. Project-local playbooks (relative to CWD)
    const projectPlaybooks = path.join(process.cwd(), ".openmono", "playbooks");
    if (fs.existsSync(projectPlaybooks))
        paths.push(projectPlaybooks);
    return paths;
}
// ─── Discovery ────────────────────────────────────────────────
/**
 * Discovers all PLAYBOOK.md files under the given search paths.
 * Returns them as PlaybookDefinition objects.
 */
export function discoverPlaybooks() {
    const searchPaths = resolveSearchPaths();
    const playbooks = [];
    const seen = new Set();
    for (const sp of searchPaths) {
        if (!fs.existsSync(sp))
            continue;
        const entries = fs.readdirSync(sp, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const pbPath = path.join(sp, entry.name, PLAYBOOK_FILENAME);
            if (fs.existsSync(pbPath)) {
                try {
                    const pb = parsePlaybookFile(pbPath);
                    if (!seen.has(pb.name)) {
                        playbooks.push(pb);
                        seen.add(pb.name);
                    }
                }
                catch (err) {
                    // Skip unparseable playbooks but log a warning
                    console.error(`[playbooks] Warning: failed to parse ${pbPath}: ${err instanceof Error ? err.message : err}`);
                }
            }
        }
    }
    return playbooks;
}
// ─── Single File Loading ─────────────────────────────────────
/**
 * Loads a single playbook by name from the search paths.
 * Returns null if not found.
 */
export function loadPlaybook(name) {
    const searchPaths = resolveSearchPaths();
    for (const sp of searchPaths) {
        const pbPath = path.join(sp, name, PLAYBOOK_FILENAME);
        if (fs.existsSync(pbPath)) {
            return parsePlaybookFile(pbPath);
        }
    }
    return null;
}
// ─── Parsing ──────────────────────────────────────────────────
/**
 * Parses a PLAYBOOK.md file into a PlaybookDefinition.
 */
export function parsePlaybookFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parsePlaybookString(raw, filePath);
}
/**
 * Parses a PLAYBOOK.md string into a PlaybookDefinition.
 */
export function parsePlaybookString(content, filePath) {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) {
        throw new Error(`No YAML frontmatter found in playbook file: ${filePath}`);
    }
    const [, yamlStr, body] = match;
    const frontmatter = yaml.load(yamlStr);
    // Validate required fields
    if (!frontmatter.name || typeof frontmatter.name !== "string") {
        throw new Error(`Playbook at ${filePath} is missing required 'name' field`);
    }
    if (!frontmatter.version || typeof frontmatter.version !== "string") {
        throw new Error(`Playbook '${frontmatter.name}' is missing required 'version' field`);
    }
    if (!frontmatter.description || typeof frontmatter.description !== "string") {
        throw new Error(`Playbook '${frontmatter.name}' is missing required 'description' field`);
    }
    // Normalize trigger
    const trigger = normalizeTrigger(frontmatter.trigger);
    const definition = {
        name: frontmatter.name,
        version: frontmatter.version,
        description: frontmatter.description,
        trigger,
        "trigger-patterns": normalizeStringArray(frontmatter["trigger-patterns"]),
        "user-invocable": frontmatter["user-invocable"] !== undefined ? Boolean(frontmatter["user-invocable"]) : true,
        "argument-hint": typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined,
        parameters: normalizeParameters(frontmatter.parameters),
        steps: normalizeSteps(frontmatter.steps),
        constraints: normalizeConstraints(frontmatter.constraints),
        "allowed-tools": normalizeStringArray(frontmatter["allowed-tools"]),
        "context-mode": normalizeContextMode(frontmatter["context-mode"]),
        tags: normalizeStringArray(frontmatter.tags),
        "depends-on": normalizeStringArray(frontmatter["depends-on"]),
        body: body.trim(),
        _path: filePath,
        _dir: path.dirname(filePath),
    };
    // Sort steps topologically if there are dependencies
    if (definition.steps && definition.steps.length > 1) {
        definition.steps = topologicalSort(definition.steps);
    }
    return definition;
}
// ─── Normalization Helpers ────────────────────────────────────
function normalizeTrigger(raw) {
    const s = String(raw ?? "manual").toLowerCase();
    if (s === "auto")
        return "auto";
    if (s === "both")
        return "both";
    return "manual";
}
function normalizeStringArray(raw) {
    if (!raw)
        return undefined;
    if (Array.isArray(raw)) {
        return raw.map(String).filter(Boolean);
    }
    return undefined;
}
function normalizeContextMode(raw) {
    const s = String(raw ?? "").toLowerCase();
    if (s === "selective")
        return "Selective";
    if (s === "fork")
        return "Fork";
    return "Full";
}
function normalizeParameters(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const params = {};
    for (const [key, val] of Object.entries(raw)) {
        if (!val || typeof val !== "object")
            continue;
        const p = val;
        const typeStr = String(p.type ?? "String");
        const paramType = ["String", "Number", "Boolean", "Array"].includes(typeStr)
            ? typeStr
            : "String";
        params[key] = {
            type: paramType,
            required: Boolean(p.required),
            default: p.default,
            hint: typeof p.hint === "string" ? p.hint : undefined,
            enum: Array.isArray(p.enum) ? p.enum.map(String) : undefined,
            min: typeof p.min === "number" ? p.min : undefined,
            max: typeof p.max === "number" ? p.max : undefined,
        };
    }
    return Object.keys(params).length > 0 ? params : undefined;
}
function normalizeSteps(raw) {
    if (!Array.isArray(raw))
        return undefined;
    return raw.map((s, i) => {
        const step = s;
        return {
            id: typeof step.id === "string" ? step.id : `step-${String(i).padStart(2, "0")}`,
            requires: Array.isArray(step.requires) ? step.requires.map(String) : [],
            file: typeof step.file === "string" ? step.file : undefined,
            "inline-prompt": typeof step["inline-prompt"] === "string" ? step["inline-prompt"] : undefined,
            script: typeof step.script === "string" ? step.script : undefined,
            gate: normalizeGate(step.gate),
            output: typeof step.output === "string" ? step.output : undefined,
            agent: typeof step.agent === "string" ? step.agent : undefined,
            playbook: typeof step.playbook === "string" ? step.playbook : undefined,
            auto_retry: Boolean(step.auto_retry),
            description: typeof step.description === "string" ? step.description : undefined,
            timeout: typeof step.timeout === "number" ? step.timeout : undefined,
        };
    });
}
function normalizeGate(raw) {
    if (!raw)
        return undefined;
    const s = String(raw);
    if (["Confirm", "Review", "Approve"].includes(s))
        return s;
    if (s.toLowerCase() === "none")
        return undefined;
    return undefined;
}
function normalizeConstraints(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const constraints = raw.map((c) => {
        const con = c;
        return {
            rule: String(con.rule ?? ""),
            severity: ["error", "warning"].includes(String(con.severity ?? ""))
                ? con.severity
                : "error",
            reason: typeof con.reason === "string" ? con.reason : undefined,
        };
    });
    return constraints.length > 0 ? constraints : undefined;
}
// ─── Topological Sort ─────────────────────────────────────────
function topologicalSort(steps) {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const inDegree = new Map();
    const adjacency = new Map();
    for (const s of steps) {
        inDegree.set(s.id, 0);
        adjacency.set(s.id, []);
    }
    for (const s of steps) {
        for (const dep of s.requires) {
            if (stepMap.has(dep)) {
                adjacency.get(dep).push(s.id);
                inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
            }
        }
    }
    const queue = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0)
            queue.push(id);
    }
    const sorted = [];
    while (queue.length > 0) {
        // Sort for deterministic ordering when multiple have indegree 0
        queue.sort();
        const id = queue.shift();
        const step = stepMap.get(id);
        if (step)
            sorted.push(step);
        for (const neighbor of adjacency.get(id) ?? []) {
            const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
            inDegree.set(neighbor, newDeg);
            if (newDeg === 0)
                queue.push(neighbor);
        }
    }
    return sorted;
}
/**
 * Validates a playbook definition and returns any issues found.
 */
export function validatePlaybook(def) {
    const issues = [];
    // Version must be valid SemVer
    if (!/^\d+\.\d+\.\d+/.test(def.version)) {
        issues.push({
            field: "version",
            message: `Version "${def.version}" is not valid SemVer`,
            severity: "error",
        });
    }
    // Steps must have either file or inline-prompt
    if (def.steps) {
        for (const step of def.steps) {
            if (!step.file && !step["inline-prompt"] && !step.playbook) {
                issues.push({
                    field: `steps[${step.id}]`,
                    message: `Step "${step.id}" has no file, inline-prompt, or playbook reference`,
                    severity: "error",
                });
            }
            // Check that requires steps actually exist
            for (const dep of step.requires) {
                if (!def.steps.some((s) => s.id === dep)) {
                    issues.push({
                        field: `steps[${step.id}].requires`,
                        message: `Step "${step.id}" depends on non-existent step "${dep}"`,
                        severity: "error",
                    });
                }
            }
        }
    }
    // Depends-on playbooks exist (soft check — we can only verify what's loaded)
    if (def["depends-on"]) {
        const all = discoverPlaybooks();
        const names = new Set(all.map((p) => p.name));
        for (const dep of def["depends-on"]) {
            if (!names.has(dep)) {
                issues.push({
                    field: "depends-on",
                    message: `Playbook "${def.name}" depends on "${dep}" which was not found in search paths`,
                    severity: "warning",
                });
            }
        }
    }
    return issues;
}
//# sourceMappingURL=loader.js.map