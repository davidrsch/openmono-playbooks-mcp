# How to Create Playbooks

A step-by-step guide from zero to a working, reusable playbook.

---

## Step 1: Create the Directory

Every playbook lives in its own subdirectory under a playbook search path. The standard location is `.openmono/playbooks/` in your project root or home directory.

```bash
mkdir -p .openmono/playbooks/my-first-playbook
```

If you need supporting files (scripts, step prompts, constraints), create those subdirectories too:

```bash
mkdir -p .openmono/playbooks/my-first-playbook/scripts
mkdir -p .openmono/playbooks/my-first-playbook/steps
```

**Directory structure:**

```
.openmono/playbooks/
└── my-first-playbook/
    ├── PLAYBOOK.md          # Required — the playbook definition
    ├── scripts/             # Optional — shell scripts for validation
    │   └── check.sh
    ├── steps/               # Optional — externalized step prompts
    │   ├── 01-detect.md
    │   └── 02-fix.md
    └── constraints.md       # Optional — reusable constraint file
```

---

## Step 2: Define the Frontmatter

Create `PLAYBOOK.md` and start with the YAML frontmatter between `---` delimiters. Only three fields are required:

```yaml
---
name: my-first-playbook # Required. Unique name.
version: 1.0.0 # Required. SemVer.
description: My first playbook # Required. Shown in listings.
---
```

### Choosing a Trigger Mode

| Trigger  | Use When                                                       |
| -------- | -------------------------------------------------------------- |
| `manual` | The user must explicitly invoke it (e.g., `/release minor`)    |
| `auto`   | It should fire automatically when user input matches a pattern |
| `both`   | Both manual and auto-trigger                                   |

For auto-trigger playbooks, provide `trigger-patterns`:

```yaml
trigger: auto
trigger-patterns:
  - "commit *"
  - "* commit changes"
  - "commit my changes"
```

Patterns use glob-style wildcards. The playbook with the longest matching pattern wins when multiple match.

---

## Step 3: Define Parameters

Parameters make your playbook reusable with different inputs. Each parameter has a type, and optional validation.

```yaml
parameters:
  target:
    type: String
    required: true
    hint: "The file or directory to scan"
  depth:
    type: Number
    required: false
    default: 3
    min: 1
    max: 10
    hint: "Recursion depth (1-10)"
  verbose:
    type: Boolean
    required: false
    default: false
    hint: "Enable verbose logging"
  tags:
    type: Array
    required: false
    default: []
    hint: "List of tags to filter by"
  severity:
    type: String
    required: false
    default: "medium"
    enum: ["low", "medium", "high", "critical"]
    hint: "Minimum severity threshold"
```

**Type reference:**

| Type      | Example Values                  | Extra Validation        |
| --------- | ------------------------------- | ----------------------- |
| `String`  | `"src/"`, `"minor"`, `"v1.2.3"` | `enum`, `default`       |
| `Number`  | `3`, `42`, `-1`                 | `min`, `max`, `default` |
| `Boolean` | `true`, `false`                 | `default`               |
| `Array`   | `["tag1", "tag2"]`              | `default`               |

---

## Step 4: Define Steps

Steps form the core workflow. Each step has an `id` and either `inline-prompt` or `file` for its content.

### Simple Two-Step Playbook

```yaml
steps:
  - id: detect-lang
    inline-prompt: |
      Run a quick scan of {{params.target}} to detect the primary programming language.
      Report: language name, build system (if any), and test framework (if any).
    output: lang-info

  - id: generate-config
    requires: [detect-lang]
    inline-prompt: |
      Based on the language detection:
      {{state.lang-info}}

      Generate a CI configuration file (.github/workflows/ci.yml) for this project.
      The config should run tests and lint for {{state.lang-info}}.
    gate: Review
    output: ci-config
```

### Adding Gates

Gates insert human checkpoints into the workflow:

```yaml
steps:
  - id: analyze
    inline-prompt: Analyze the codebase for security issues.
    gate: None # Runs automatically

  - id: generate-fix
    requires: [analyze]
    inline-prompt: Generate patches for the security issues found.
    gate: Confirm # User must approve before the LLM is called

  - id: apply-fix
    requires: [generate-fix]
    inline-prompt: Apply the generated patches to the codebase.
    gate: Review # User reviews the output before next step
    output: fix-result

  - id: push
    requires: [apply-fix]
    inline-prompt: Commit and push the changes.
    gate:
      Approve # User must approve before AND after execution
      # (preview the commit message, then review the push result)
```

### Using External Step Files

For complex or reusable steps, externalize the prompt to a Markdown file:

```yaml
steps:
  - id: analyze
    file: steps/01-analyze.md # Relative to playbook directory
    output: analysis

  - id: report
    requires: [analyze]
    file: steps/02-report.md
    gate: Review
```

`steps/01-analyze.md`:

```markdown
You are analyzing the repository at the current working directory.
Your task:

1. Run `git log --oneline -20` to see recent changes.
2. Categorize each commit as feat, fix, chore, docs, refactor, test, style, or perf.
3. Identify the highest-impact change type.
4. Report: total commits, breakdown by type, highest-impact type.

Use the scope parameter: {{params.scope}}

Be concise. Output as structured text, not JSON.
```

### Using Shell Scripts

Shell scripts run for validation. Non-zero exit = step failure:

```yaml
steps:
  - id: pre-flight
    inline-prompt: Run the pre-flight check script.
    script: scripts/pre-flight.sh
    gate: None
```

`scripts/pre-flight.sh`:

```bash
#!/bin/bash
set -euo pipefail
echo "Checking git status..."
if ! git diff-index --quiet HEAD --; then
    echo "ERROR: Working tree is dirty. Commit or stash changes first."
    exit 1
fi
echo "Checking node..."
command -v node >/dev/null 2>&1 || { echo "ERROR: node is not installed."; exit 1; }
echo "All checks passed."
```

---

## Step 5: Write the Role Description (Markdown Body)

The text after the second `---` becomes the agent's system prompt for every step:

```markdown
---

You are a CI/CD configuration assistant. Your job is to analyze a repository
and generate appropriate CI pipeline configurations.

## Rules

1. Always check existing CI configurations before generating new ones.
2. Support these CI systems: GitHub Actions, GitLab CI, Jenkins (declarative).
3. Generate minimal configurations — only what the project actually needs.
4. If a step has a gate, explain clearly what will happen before asking for approval.
5. When using parameter values, always double-check they are reasonable.

## Output Format

- Use code blocks with language identifiers for all generated files.
- Prefix each file with its intended path.
- Include a brief explanation of what each configuration section does.
```

---

## Step 6: Add Constraints (Safety Guardrails)

Constraints are automatically injected into every step's prompt.

### Inline Constraints

```yaml
constraints:
  inline:
    - "Never modify files under .git/ or node_modules/."
    - "Never commit secrets, .env files, or *.pem certificates."
    - "Never force-push, rebase, or delete protected branches."
    - "Never run destructive commands (rm -rf, DROP TABLE, etc.) without an Approve gate."
```

### File-Based Constraints

```yaml
constraints:
  file: constraints.md
```

`constraints.md`:

```markdown
- Never modify files under .git/ or node_modules/.
- Never commit secrets or credentials.
- Always validate generated code with the appropriate linter before saving.
- Stop and ask for clarification if the user's intent is ambiguous.
```

---

## Step 7: Control Tool Access

Restrict which tools the playbook's agent can use:

```yaml
allowed-tools:
  - Shell # Run shell commands
  - ReadFile # Read files from disk
  - WriteFile # Write files to disk
  - Search # Search the codebase
  - Glob # Find files by pattern
  # - Git        # NOT allowed — prevent direct git operations
  # - Docker     # NOT allowed — prevent container operations
```

Use `"*"` to allow all tools:

```yaml
allowed-tools:
  - "*"
```

---

## Step 8: Choose Context Mode

| Mode        | Token Usage | When to Use                                                         |
| ----------- | ----------- | ------------------------------------------------------------------- |
| `Full`      | High        | Simple playbooks with few steps                                     |
| `Selective` | Medium      | Multi-step playbooks; saves tokens by only sending relevant context |
| `Fork`      | Low         | Independent steps that don't need prior step history                |

```yaml
context-mode: Selective
max-context-tokens: 8000
```

---

## Step 9: Test Your Playbook

### Validate syntax

Use the MCP `validate_playbook` tool to check your playbook without executing it:

```json
{
  "tool": "validate_playbook",
  "arguments": {
    "name": "my-first-playbook"
  }
}
```

### Execute

Run it via your agent:

```
/run_playbook my-first-playbook --target src/ --verbose true
```

Or via the MCP tool:

```json
{
  "tool": "run_playbook",
  "arguments": {
    "name": "my-first-playbook",
    "parameters": {
      "target": "src/",
      "verbose": true
    }
  }
}
```

### Debug

- Check `~/.openmono/playbook-state/` for checkpoint files showing step progress
- Use `get_playbook_state` to inspect a running or completed playbook
- Use `resume_playbook` to continue from a crash

---

## Complete Example

Here's a full, working playbook:

```yaml
---
name: code-review
version: 1.0.0
description: Review staged changes for code quality, security, and style issues.
trigger: manual
user-invocable: true
argument-hint: "[--strict] [--focus <area>]"

parameters:
  strict:
    type: Boolean
    required: false
    default: false
    hint: "Apply strict linting rules (treat warnings as errors)"
  focus:
    type: String
    required: false
    default: "all"
    enum: ["all", "security", "performance", "style"]
    hint: "Review focus area"

allowed-tools:
  - Shell
  - ReadFile
  - Search
  - Glob

context-mode: Selective
max-context-tokens: 6000

tags:
  - git
  - review
  - quality

constraints:
  inline:
    - "Never modify files — this is a read-only review."
    - "Never access files outside the repository root."

steps:
  - id: detect-changes
    inline-prompt: |
      Run `git diff --staged` to see staged changes.
      If nothing is staged, run `git diff` to see unstaged changes.
      Summarize: which files changed, how many lines added/removed, primary languages.
    gate: None
    output: changes-summary

  - id: static-analysis
    requires: [detect-changes]
    inline-prompt: |
      Review the changed files for:
      1. Code style issues (naming, formatting, consistency)
      2. Potential bugs (null refs, off-by-one, race conditions)
      3. Security concerns (injection, XSS, exposed secrets)
      4. Performance issues (N+1 queries, unnecessary allocations)

      Changed files summary:
      {{state.changes-summary}}

      Focus area: {{params.focus}}
      Strict mode: {{params.strict}}

      For each issue found, include:
      - File and line reference
      - Severity (low/medium/high/critical)
      - One-line description
      - Suggested fix
    gate: None
    output: issues

  - id: summary-report
    requires: [static-analysis]
    inline-prompt: |
      Generate a review summary:

      Issues found:
      {{state.issues}}

      Format:
      # Code Review Summary

      ## Changes
      {{state.changes-summary}}

      ## Issues ({{state.issues}} count)
      [list each issue with severity badge]

      ## Recommendation
      - If critical or high issues: BLOCK merge
      - If only medium: CAUTION — fix before merge if {{params.strict}}
      - If only low: OK to merge
    gate: Review
    output: review-report
---
You are a code review assistant. Your job is to analyze code changes
and provide actionable, constructive feedback.

## Principles

1. Be specific — reference exact files and line numbers.
2. Be constructive — always suggest a fix, not just flag problems.
3. Be proportionate — don't nitpick style if there are security issues.
4. Respect the focus parameter — if `focus: security`, prioritize security findings.
5. Never modify code — this is a read-only review.
```

---

## Quick Reference: Minimal Playbook

```yaml
---
name: hello
version: 1.0.0
description: A minimal playbook example.
trigger: manual
steps:
  - id: greet
    inline-prompt: Say hello to the user and list the files in the current directory.
---
You are a friendly assistant. Keep responses brief.
```

That's it — 10 lines of YAML and one line of Markdown. Copy this, save as `.openmono/playbooks/hello/PLAYBOOK.md`, and run `/run_playbook hello`.

---

## Next Steps

- See [PLAYBOOKS.md](PLAYBOOKS.md) for the full format reference
- See [PLAYBOOKS-EXAMPLES.md](PLAYBOOKS-EXAMPLES.md) for annotated real-world examples
- See [COMPARISON.md](COMPARISON.md) for Playbooks vs. Skills vs. MCP
