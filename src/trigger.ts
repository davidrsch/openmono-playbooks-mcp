/**
 * Trigger Pattern Matching Engine
 *
 * Matches user input against playbook trigger patterns using
 * glob/wildcard matching with weighted scoring.
 *
 * Patterns support:
 *   - Exact match: "commit"
 *   - Prefix wildcard: "commit *"
 *   - Suffix wildcard: "* commit"
 *   - Full wildcard: "commit * message"
 *   - Multiple patterns per playbook
 */

import type { PlaybookDefinition } from "./types.js";

export interface TriggerMatch {
  playbook: PlaybookDefinition;
  score: number;
  matchedPattern: string;
}

/**
 * Convert a trigger pattern to a case-insensitive regex.
 * Supports * as a multi-character wildcard and ? as a single-character wildcard.
 */
function patternToRegex(pattern: string): RegExp {
  // Escape all regex special characters first, including * and ? which are
  // wildcards in trigger patterns but quantifiers in regex.
  const escaped = pattern.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
  const regexStr = escaped
    .replace(/\\\*/g, ".*") // * → .*
    .replace(/\\\?/g, "."); // ? → .
  return new RegExp(`^${regexStr}$`, "i");
}

/**
 * Score a pattern match against user input.
 * Higher scores indicate better matches:
 *   - Exact match: 100
 *   - Prefix match (pattern starts input): 80 * (pattern specificity)
 *   - Substring match: 50
 *   - Wildcard match: pattern length relative score
 */
function scoreMatch(input: string, pattern: string): number {
  const lowerInput = input.toLowerCase().trim();
  const lowerPattern = pattern.toLowerCase().trim();

  // Exact match (highest priority)
  if (lowerInput === lowerPattern) return 100;

  // Input starts with the non-wildcard prefix of the pattern
  const prefix = lowerPattern.replace(/\*.*$/, "");
  if (prefix && lowerInput.startsWith(prefix)) {
    const specificity = prefix.length / Math.max(lowerInput.length, 1);
    return Math.round(80 * specificity);
  }

  // Pattern (without wildcards) is a substring of input
  const core = lowerPattern.replace(/\*/g, "").trim();
  if (core && lowerInput.includes(core)) {
    const specificity = core.length / Math.max(lowerInput.length, 1);
    return Math.round(50 * specificity);
  }

  // Regex match (wildcard pattern matched but not exact/prefix/substring)
  if (pattern.includes("*") || pattern.includes("?")) {
    const regex = patternToRegex(pattern);
    if (regex.test(lowerInput)) {
      return 30; // Base score for wildcard match
    }
  }

  return 0;
}

/**
 * Match user input against all available playbooks with auto-trigger patterns.
 * Returns playbooks sorted by match score descending.
 * Only playbooks with trigger mode "auto" or "both" are considered.
 */
export function matchTrigger(input: string, playbooks: PlaybookDefinition[]): TriggerMatch[] {
  const matches: TriggerMatch[] = [];

  for (const pb of playbooks) {
    // Only match playbooks configured for auto-trigger
    if (pb.trigger !== "auto" && pb.trigger !== "both") continue;

    const patterns = pb["trigger-patterns"];
    if (!patterns || patterns.length === 0) continue;

    for (const pattern of patterns) {
      const score = scoreMatch(input, pattern);
      if (score > 0) {
        matches.push({
          playbook: pb,
          score,
          matchedPattern: pattern,
        });
      }
    }
  }

  // Sort by score descending, then by playbook name for determinism
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.playbook.name.localeCompare(b.playbook.name);
  });

  return matches;
}

/**
 * Find the single best-matching playbook for the given input.
 * Returns null if no playbook matches.
 */
export function findBestMatch(input: string, playbooks: PlaybookDefinition[]): TriggerMatch | null {
  const matches = matchTrigger(input, playbooks);
  return matches.length > 0 ? matches[0] : null;
}
