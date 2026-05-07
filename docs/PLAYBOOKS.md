# What Are Playbooks?

Playbooks are **declarative, versioned, multi-step AI workflows** encoded as YAML+Markdown files (`PLAYBOOK.md`). They enable repeatable software engineering processes to be executed by an AI agent with precise control over tool access, human checkpoints, parameter validation, step ordering, and fault tolerance via checkpoint/resume.

A playbook is a single file with two parts: a YAML frontmatter section (metadata, parameters, steps, constraints) and a Markdown body (the agent's system prompt / role description).

---

## PLAYBOOK.md File Format

```yaml
---
# ═══ YAML Frontmatter ═══
name: <string>                  # Required. Unique playbook identifier.
version: <semver>               # Required. SemVer string (e.g., "1.0.0").
description: <string>           # Required. One-line summary shown in listings.
trigger: manual | auto | both   # How the playbook is invoked.
trigger-patterns:               # Glob patterns for auto-trigger matching.
  - "<pattern>"
user-invocable: <bool>          # Whether the user can invoke this directly (default: true).
argument-hint: <string>         # Shown in help text, e.g., "--scope <scope>"

parameters:                     # Typed input parameters.
  <param-name>:
    type: String | Number | Boolean | Array
    required: <bool>
    default: <any>
    hint: <string>              # Help text.
    enum: [<value1>, <value2>]  # Allowed values (String params).
    min: <number>               # Minimum value (Number params).
    max: <number>               # Maximum value (Number params).

allowed-tools:                  # Tools the playbook may use. "*" = all tools.
  - <tool-name>
  - "*"

context-mode: Full | Selective | Fork
max-context-tokens: <number>    # Token budget (Selective mode).
depends-on: []                  # Other playbooks this one depends on.

tags:                           # For discovery and filtering.
  - <tag>

constraints:                    # Safety guardrails.
  file: <path>                  # Path to constraints file (relative to playbook dir).
  inline:                       # Inline constraint strings.
    - "<constraint>"
    - "<constraint>"

steps:                          # Ordered steps (topo-sorted by `requires`).
  - id: <string>                # Unique step ID within this playbook.
    requires: [<step-id>]       # Steps that must complete before this one.
    file: <path>                # Path to step prompt (relative to playbook dir).
    inline-prompt: <string>     # Inline step prompt.
    script: <path>              # Shell script to execute for validation.
    gate: None | Confirm | Review | Approve
    agent: <agent-name>         # Sub-agent to use for this step.
    playbook: <playbook-name>   # Sub-playbook to invoke.
    parameters:                 # Parameters to pass to sub-playbook.
      <key>: <value>
    output: <key>              # Store step result under this key in state.
---
# ═══ Markdown Body ═══
You are a [role]. Your job is to:
1. ...
2. ...
```

---

## Frontmatter Fields Reference

### Top-Level Fields

| Field                | Type                          | Required               | Description                                                             |
| -------------------- | ----------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `name`               | string                        | ✅                     | Unique playbook identifier (e.g., `commit`, `release`)                  |
| `version`            | string                        | ✅                     | SemVer version (e.g., `1.0.0`)                                          |
| `description`        | string                        | ✅                     | One-line summary shown in playbook listings                             |
| `trigger`            | `manual` / `auto` / `both`    | ❌ (default: `manual`) | How the playbook is invoked                                             |
| `trigger-patterns`   | string[]                      | ❌                     | Glob patterns for auto-trigger. Used when `trigger` is `auto` or `both` |
| `user-invocable`     | boolean                       | ❌ (default: `true`)   | Whether the user can invoke this directly                               |
| `argument-hint`      | string                        | ❌                     | Shown in help text (e.g., `"[--scope <scope>] [--message <msg>]"`)      |
| `allowed-tools`      | string[]                      | ❌ (default: `["*"]`)  | Tools the playbook may use. `"*"` means all tools                       |
| `context-mode`       | `Full` / `Selective` / `Fork` | ❌ (default: `Full`)   | How context is managed across steps                                     |
| `max-context-tokens` | number                        | ❌                     | Token budget when `context-mode` is `Selective`                         |
| `depends-on`         | string[]                      | ❌                     | Other playbooks this one depends on                                     |
| `tags`               | string[]                      | ❌                     | For discovery and filtering                                             |
| `constraints`        | object                        | ❌                     | Safety guardrails — file path or inline strings                         |

### Context Modes

| Mode        | Behavior                                                                          |
| ----------- | --------------------------------------------------------------------------------- |
| `Full`      | All conversation history is available to every step.                              |
| `Selective` | Only the current step's prompt and relevant prior outputs are sent. Saves tokens. |
| `Fork`      | Each step runs in a fresh, isolated context.                                      |

### Trigger Modes

| Mode     | Behavior                                                 |
| -------- | -------------------------------------------------------- |
| `manual` | Invoked explicitly by the user (e.g., `/release minor`). |
| `auto`   | Triggered when user input matches a `trigger-pattern`.   |
| `both`   | Can be invoked manually or triggered automatically.      |

Pattern matching uses glob-style wildcards. When multiple playbooks match, the one with the longest matching pattern wins.

---

## Parameters Reference

Each parameter supports:

| Field      | Type                                      | Required              | Description                             |
| ---------- | ----------------------------------------- | --------------------- | --------------------------------------- |
| `type`     | `String` / `Number` / `Boolean` / `Array` | ✅                    | Parameter data type                     |
| `required` | boolean                                   | ❌ (default: `false`) | Whether the parameter must be provided  |
| `default`  | any                                       | ❌                    | Default value if not provided           |
| `hint`     | string                                    | ❌                    | Help text shown to the user             |
| `enum`     | string[]                                  | ❌                    | Allowed values (String parameters only) |
| `min`      | number                                    | ❌                    | Minimum value (Number parameters only)  |
| `max`      | number                                    | ❌                    | Maximum value (Number parameters only)  |

Before execution begins, all parameters are validated: type checking, required presence, enum membership, and min/max range constraints. Invalid parameters cause the playbook to abort before any step runs.

---

## Steps Reference

Each step is a unit of work in the playbook DAG. Steps execute in dependency order (via topological sort of the `requires` graph).

| Field           | Type                                      | Required             | Description                                                                         |
| --------------- | ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `id`            | string                                    | ✅                   | Unique identifier within the playbook                                               |
| `requires`      | string[]                                  | ❌                   | IDs of steps that must complete before this one                                     |
| `file`          | string                                    | ❌                   | Path to a Markdown file containing the step prompt (relative to playbook directory) |
| `inline-prompt` | string                                    | ❌                   | Inline prompt text (alternative to `file`)                                          |
| `script`        | string                                    | ❌                   | Shell script to execute for validation. Non-zero exit = step failure                |
| `gate`          | `None` / `Confirm` / `Review` / `Approve` | ❌ (default: `None`) | Human checkpoint before or after this step                                          |
| `agent`         | string                                    | ❌                   | Sub-agent name to delegate this step to                                             |
| `playbook`      | string                                    | ❌                   | Name of another playbook to invoke as a sub-routine                                 |
| `parameters`    | object                                    | ❌                   | Parameters to pass to the sub-playbook                                              |
| `output`        | string                                    | ❌                   | Key to store this step's result in state (`{{state.<key>}}`)                        |

### Gate Types

| Gate      | Behavior                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `None`    | No human checkpoint. Step runs fully automated.                                                                             |
| `Confirm` | Simple y/N prompt. Step description shown, user confirms before execution.                                                  |
| `Review`  | Step output is shown after execution. User acknowledges before next step.                                                   |
| `Approve` | Both preview (before) and review (after). Most restrictive — used for destructive actions like `git push` or `docker push`. |

### Step Execution Flow

For each step in dependency order:

1. Load step prompt from `file` or `inline-prompt`
2. Resolve all template variables in the prompt
3. Inject constraints into the prompt
4. Execute shell `script` if specified (non-zero exit aborts)
5. Apply gate check (if `Confirm` or `Approve`, prompt user before executing)
6. Send prompt to LLM and enter agentic loop (up to 10 tool-call iterations)
7. Collect output, store under `output` key if specified
8. Apply gate check (if `Review` or `Approve`, show output to user)
9. Persist checkpoint to disk

---

## Template Variables

Prompts support variable substitution before being sent to the LLM:

| Variable                   | Resolves To                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| `{{params.<name>}}`        | Value of a playbook parameter                                                |
| `{{state.<key>}}`          | Output of a previous step (set via `output` field)                           |
| `{{constraints}}`          | Rendered constraints block (from `constraints.file` or `constraints.inline`) |
| `{{playbook.base-path}}`   | Absolute path to the playbook's directory                                    |
| `{{env.CWD}}`              | Current working directory                                                    |
| `{{env.GIT_BRANCH}}`       | Current git branch (resolved via `git branch --show-current`)                |
| `{{env.DATE}}`             | Current date in ISO 8601 format                                              |
| `{{file:<relative-path>}}` | Contents of a file (inlined at resolution time)                              |
| `{{shell:<command>}}`      | Stdout from a shell command (executed at resolution time)                    |

Example:

```
Using scope {{params.scope}}, the new version will be {{params.tag-prefix}}{{state.new_version}}.
Current branch: {{env.GIT_BRANCH}}.
Constraints:
{{constraints}}
```

---

## Constraint Injection

Constraints are safety guardrails automatically merged into every step's prompt. They can be defined in two ways:

### Inline Constraints

```yaml
constraints:
  inline:
    - "Never force-push, rebase, or delete the main/master branch."
    - "Never commit secrets, .env files, or *.pem certificates."
```

### File-Based Constraints

```yaml
constraints:
  file: constraints.md
```

The file path is relative to the playbook directory. The file's contents are injected verbatim.

---

## Discovery & Loading

Playbooks are discovered at startup and on-demand from these locations (in priority order):

1. **Compiled-in playbooks** (shipped with the agent)
2. **`~/.openmono/playbooks/`** — user-global playbooks
3. **`.openmono/playbooks/`** — project-local playbooks
4. **Additional workspace directories** added via configuration

Each playbook lives in its own subdirectory containing `PLAYBOOK.md` and optionally `scripts/` and `steps/`:

```
.openmono/playbooks/
├── commit/
│   └── PLAYBOOK.md
├── release/
│   ├── PLAYBOOK.md
│   ├── scripts/
│   │   ├── pre-flight.sh
│   │   ├── validate-tests.sh
│   │   └── tag-and-push.sh
│   └── steps/
│       ├── 01-analyze.md
│       ├── 02-changelog.md
│       └── 03-version.md
└── my-custom-workflow/
    ├── PLAYBOOK.md
    └── scripts/
        └── validate.sh
```

---

## State & Checkpointing

After every step completes, the playbook engine persists a checkpoint to `~/.openmono/playbook-state/<playbook-name>_<session-id>.json`. The checkpoint contains:

- Playbook name and session ID
- Start timestamp
- Input parameters (as supplied)
- Completed step IDs
- Step outputs (keyed dictionary, stored via the `output` field)
- Current step being executed
- Token usage counter

This enables **resume**: if the agent crashes mid-playbook, re-running the same playbook with the same session ID will skip completed steps and continue from the last incomplete one.

---

## Sub-Playbook Invocation

A step can invoke another playbook as a sub-routine using the `playbook` and `parameters` fields:

```yaml
steps:
  - id: lint-check
    playbook: lint
    parameters:
      path: src/
      strict: true
    requires: []
    output: lint-result
```

The sub-playbook runs to completion in an isolated context, and its final output is stored under the parent step's `output` key.

---

## Comparison: Playbooks vs. Skills vs. MCP

|                       | Playbooks                              | Skills (Claude Code)  | MCP Servers              |
| --------------------- | -------------------------------------- | --------------------- | ------------------------ |
| **What it is**        | Workflow orchestration engine          | Instruction injection | Tool/capability provider |
| **Format**            | YAML frontmatter + Markdown body       | Plain Markdown        | Code (various languages) |
| **Parameters**        | Typed, validated, defaults, enums      | None                  | Defined per tool         |
| **Multi-step**        | ✅ DAG with dependencies               | ❌ Single-shot        | ❌ Per-tool              |
| **Human gates**       | ✅ 4 levels (Confirm, Review, Approve) | ❌                    | ❌                       |
| **Checkpoint/resume** | ✅ After every step                    | ❌                    | ❌                       |
| **Composability**     | ✅ Playbooks call playbooks            | ❌                    | ❌ (servers can compose) |
| **State**             | Named outputs, persisted to disk       | Stateless             | Optional server-side     |

Playbooks absorb the Skill layer entirely. A Skill is just a Playbook with zero steps, zero parameters, and zero gates — the Markdown body _is_ the system prompt. Playbooks and MCP are complementary: MCP provides tools, Playbooks orchestrate their use.

---

## Writing Your Own Playbook

### Step 1: Create the directory

```bash
mkdir -p .openmono/playbooks/my-workflow
```

### Step 2: Write PLAYBOOK.md

```yaml
---
name: my-workflow
version: 1.0.0
description: A custom workflow that does something useful.
trigger: manual
user-invocable: true
argument-hint: "[--verbose]"

parameters:
  verbose:
    type: Boolean
    required: false
    default: false
    hint: "Enable verbose output"

allowed-tools:
  - Shell
  - ReadFile
  - WriteFile
  - Search

context-mode: Selective
max-context-tokens: 4000

tags:
  - custom
  - example

steps:
  - id: analyze
    inline-prompt: |
      Run `git status` and `git diff` to understand the current state of the repository.
      Summarize what files have changed and what the changes are about.
    gate: None
    output: analysis

  - id: report
    requires: [analyze]
    inline-prompt: |
      Based on the analysis:
      {{state.analysis}}

      Write a summary report to REPORT.md.
      If verbose mode is enabled ({{params.verbose}}), include detailed file-by-file breakdown.
    gate: Review
---
You are a repository analysis assistant. Your job is to inspect the current state
of the repository and produce a clear, actionable summary report.

Be concise and factual. Do not make recommendations unless asked.
```

### Step 3: Test it

Invoke from your agent:

```
/run_playbook my-workflow --verbose true
```

Or via the MCP tool:

```json
{
  "name": "my-workflow",
  "parameters": {
    "verbose": true
  }
}
```

### Step 4: Iterate

- Add steps with `requires` to build a DAG
- Add gates (`Confirm`, `Review`, `Approve`) at critical points
- Externalize step prompts to `steps/*.md` files for cleaner PLAYBOOK.md
- Add shell scripts in `scripts/` for automated validation
- Set `output` keys to pass data between steps via `{{state.<key>}}`
