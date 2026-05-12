---
name: playbooks
description: Protocol for executing OpenMono Playbooks via the playbooks-mcp MCP server. Use when the user asks to run a playbook, mentions commit/release/workflow, or when a PLAYBOOK.md file is discovered.
applyTo: "**/*"
allowed-tools:
  - mcp_playbooks_mcp_run_playbook
  - mcp_playbooks_mcp_complete_step
  - mcp_playbooks_mcp_skip_step
  - mcp_playbooks_mcp_fail_step
  - mcp_playbooks_mcp_resume_playbook
  - mcp_playbooks_mcp_get_playbook_state
  - mcp_playbooks_mcp_match_playbook
  - mcp_playbooks_mcp_list_playbooks
  - mcp_playbooks_mcp_acknowledge_gate
  - mcp_playbooks_mcp_validate_playbook
  - mcp_playbooks_mcp_health_check
---

# Playbook Execution Protocol

Playbooks are **multi-step AI workflows** defined in `PLAYBOOK.md` files. They are NOT documentation to be read — they are **workflows to be executed** through the MCP server.

## CRITICAL: How to Use Playbooks

When a `PLAYBOOK.md` file exists in the project, or the user mentions a workflow (commit, release, deploy, etc.):

### Step 1: Discover or Match

- Call `match_playbook` with the user's input to find the best playbook
- Or call `list_playbooks` to browse available playbooks

### Step 2: Execute (the mandatory loop)

1. **Call `run_playbook`** with the playbook name and typed parameters
2. **Execute the step** — follow the "System Prompt" and "Step Prompt" in the response
3. **Call `complete_step`** with the `runId` when the step is done. Pass `output` if the step defines a named output key
4. **Repeat** from step 2 for each subsequent step until the run is completed

### Step 3: Handle Gates

- If a step has a gate (Confirm/Review/Approve), the run pauses
- Present the step output to the user for review
- Call `acknowledge_gate` after the user confirms

### Never do this:

- ❌ Read `PLAYBOOK.md` with `read_file` and try to follow it manually
- ❌ Treat the playbook body as a skill/prompt without calling `run_playbook`
- ❌ Skip calling `complete_step` after finishing a step

### Always do this:

- ✅ Call `run_playbook` → execute step → call `complete_step`
- ✅ Pass the `runId` through every step-control call
- ✅ Use `get_playbook_state` to inspect progress
- ✅ Use `resume_playbook` if execution is interrupted

## Trigger Patterns

Playbooks can auto-trigger based on user input glob patterns. When the user says something that matches a trigger pattern, call `match_playbook` to confirm, then `run_playbook` to execute.

## Error Recovery

If `complete_step` fails with "Run not found", the run may have been evicted from memory but persisted to disk. Call `resume_playbook` with the same `runId` to restore it.
