# Playbooks vs. Skills vs. MCP

A detailed comparison of the three concepts in the AI coding agent ecosystem.

---

## Quick Summary

|                       | Playbooks                              | Skills (Claude Code)   | MCP Servers                    |
| --------------------- | -------------------------------------- | ---------------------- | ------------------------------ |
| **What it is**        | Workflow orchestration engine          | Instruction injection  | Tool/capability provider       |
| **Format**            | YAML frontmatter + Markdown body       | Plain Markdown         | Code (various languages)       |
| **Parameters**        | Typed, validated, defaults, enums      | None                   | Defined per tool               |
| **Multi-step**        | ✅ DAG with dependencies               | ❌ Single-shot         | ❌ Per-tool (no orchestration) |
| **Human gates**       | ✅ 4 levels (Confirm, Review, Approve) | ❌                     | ❌                             |
| **Checkpoint/resume** | ✅ After every step                    | ❌                     | ❌                             |
| **Composability**     | ✅ Playbooks call playbooks            | ❌                     | ❌ (servers can compose)       |
| **State management**  | Named outputs, persisted to disk       | Stateless              | Optional server-side           |
| **Versioning**        | ✅ SemVer                              | ❌                     | ❌                             |
| **Constraint system** | ✅ Inline + file-based safety rules    | ❌                     | ❌                             |
| **Trigger system**    | ✅ Pattern-based auto-trigger          | ❌                     | ❌                             |
| **Shell integration** | ✅ Scripts as validators + live shell  | ❌ (manual tool calls) | ❌ (manual tool calls)         |

---

## Playbooks vs. Skills

### What Skills Are

Skills in Claude Code are plain Markdown files containing instructions that get injected into the agent's context. They shape the agent's behavior for a specific domain.

```markdown
# Security Reviewer Skill

You are a security reviewer. When reviewing code, check for:

1. OWASP Top 10 vulnerabilities
2. Hardcoded secrets
3. Unsafe deserialization
4. ...
```

### What Playbooks Add

A Playbook is a strict superset. The Markdown body _is_ the Skill — it becomes the system prompt. But Playbooks add:

1. **Typed parameters** — Reusable with different inputs. A Skill is always the same text.
2. **Multi-step DAG** — Steps with dependencies. A Skill is single-shot.
3. **Human gates** — Confirm, Review, Approve at critical junctures.
4. **Checkpoint/resume** — Crash recovery. Skills are ephemeral.
5. **Composability** — Playbooks calling playbooks.
6. **Constraint injection** — Safety rules merged automatically.
7. **Pattern triggers** — Auto-invoke based on user input.

### Can Skills Be Replaced by Playbooks?

**Yes, completely.** A Skill is just a Playbook with:

```yaml
---
name: my-skill
version: 1.0.0
description: My domain instructions.
trigger: manual
steps: [] # No steps — just the role description
---
[Skill content here]
```

The Playbook format absorbs the Skill layer entirely. You get the same instruction injection plus all the extra capabilities if you need them later.

---

## Playbooks vs. MCP

### What MCP Is

The Model Context Protocol (MCP) is a transport protocol for connecting AI agents to external tool servers. It defines:

- A JSON-RPC communication transport (stdio, SSE, WebSocket)
- Tool discovery and invocation
- Resource access
- Prompt templates

MCP servers provide **tools** and **resources** — not workflows.

### How They Differ

| Dimension           | Playbooks                      | MCP                                     |
| ------------------- | ------------------------------ | --------------------------------------- |
| **Layer**           | Application (agent behavior)   | Transport (tool connectivity)           |
| **Analogy**         | CI/CD pipeline                 | Plugin API                              |
| **What it defines** | "Do this process"              | "Here's a new capability"               |
| **State**           | Checkpointed, resumable        | Stateless (or server-side)              |
| **Users**           | End users (via slash commands) | Developers (when building integrations) |

### How They Work Together

They are **complementary, orthogonal layers**. A Playbook step runs in the agentic loop and calls tools — any tools, including MCP-provided ones:

```
Playbook "release"
  └─ Step "analyze-changes"
       └─ Agentic loop (up to 10 tool iterations)
            ├─ Shell tool (built-in)           ← runs git log
            ├─ ReadFile tool (built-in)        ← reads version files
            └─ CodeGraph MCP tool (external)   ← semantic analysis via MCP
```

The Playbook doesn't care where the tool comes from. MCP provides capabilities, Playbooks orchestrate their use.

---

## The Three-Layer Model

```
┌─────────────────────────────────────────────────┐
│  PLAYBOOKS                                      │
│  "What to do, in what order, with what checks"  │
│  WORKFLOW ORCHESTRATION LAYER                   │
│                                                 │
│  ✅ Multi-step workflows                        │
│  ✅ Human-in-the-loop gates                     │
│  ✅ Typed parameters                            │
│  ✅ Checkpoint/resume                           │
│  ✅ Composability                               │
├─────────────────────────────────────────────────┤
│  (SKILLS — absorbed by Playbooks)               │
│  "How to think about this task"                 │
│                                                 │
│  Now just the Markdown body of a Playbook       │
├─────────────────────────────────────────────────┤
│  TOOLS + MCP                                    │
│  "What capabilities are available"              │
│  CAPABILITY LAYER                               │
│                                                 │
│  ✅ Built-in tools (Shell, ReadFile, ...)       │
│  ✅ MCP tools (Playwright, databases, APIs)     │
│  ✅ Language intelligence (LSP, Roslyn)         │
└─────────────────────────────────────────────────┘
```

---

## When to Use Each

### Use MCP Servers When

- You need a new capability (browser automation, database queries, external APIs)
- The capability is stateless and tool-like
- You want to share tools across different agents

### Use Playbooks When

- You have a multi-step process (commit → review → release → deploy)
- You need human approval at critical steps
- You want crash recovery and resumability
- You want typed, validated input parameters
- You want to compose workflows (lint → test → build)
- You need safety guardrails injected automatically

### You Don't Need Separate Skills When

- You have Playbooks — the Markdown body covers instruction injection
- You need ad-hoc instructions — just type them in the chat

---

## Why Playbooks Fill a Unique Gap

Skills and MCP are **horizontal** extensions — they add more instructions and more tools. Playbooks are a **vertical** extension — they add structure, safety, and repeatability on top of whatever instructions and tools exist.

You could have 100 MCP servers and 50 Skills, but without something like Playbooks, you still lack:

1. **Multi-step orchestration** — coordinating tool use across phases
2. **Human-in-the-loop gates** — pausing for approval before destructive actions
3. **Fault tolerance** — checkpoint/resume so a crash doesn't lose progress
4. **Input validation** — rejecting bad parameters before execution starts
5. **Composability** — one workflow calling another as a sub-routine

That's the gap Playbooks fill. They're the **workflow engine** that Skills and MCP were never designed to be.
