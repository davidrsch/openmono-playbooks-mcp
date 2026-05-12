/**
 * Playbook Loader
 *
 * Discovers, parses, and validates PLAYBOOK.md files from the filesystem.
 * Mirrors the discovery logic from OpenMonoAgent.ai's PlaybookLoader.cs
 * and PlaybookRegistry.cs.
 */
import type { PlaybookDefinition } from "./types.js";
/**
 * Resolves the ordered list of directories to search for playbooks.
 * Order: PLAYBOOKS_PATH env var, WORKSPACE_ROOTS env var,
 * ~/.openmono/playbooks, process.cwd()/.openmono/playbooks
 */
export declare function resolveSearchPaths(): string[];
/**
 * Discovers all PLAYBOOK.md files under the given search paths.
 * Returns them as PlaybookDefinition objects.
 */
export declare function discoverPlaybooks(): PlaybookDefinition[];
/**
 * Loads a single playbook by name from the search paths.
 * Returns null if not found.
 */
export declare function loadPlaybook(name: string): PlaybookDefinition | null;
/**
 * Parses a PLAYBOOK.md file into a PlaybookDefinition.
 */
export declare function parsePlaybookFile(filePath: string): PlaybookDefinition;
/**
 * Parses a PLAYBOOK.md string into a PlaybookDefinition.
 */
export declare function parsePlaybookString(content: string, filePath: string): PlaybookDefinition;
export interface ValidationIssue {
    field: string;
    message: string;
    severity: "error" | "warning";
}
/**
 * Validates a playbook definition and returns any issues found.
 */
export declare function validatePlaybook(def: PlaybookDefinition): ValidationIssue[];
