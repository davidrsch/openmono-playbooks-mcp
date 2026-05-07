# Attribution

## Original Work

This project is inspired by and derives its playbook engine, format specification, and example playbooks from **[OpenMonoAgent.ai](https://github.com/StartupHakk/OpenMonoAgent.ai)** by **[StartupHakk](https://github.com/StartupHakk)**.

The playbook concept — declarative, versioned, multi-step AI workflows encoded as YAML+Markdown files with typed parameters, human-in-the-loop gates, step dependencies, checkpointing, and template variable resolution — was pioneered in the OpenMonoAgent.ai project.

## What We've Built On

The following concepts, formats, and specifications originate from OpenMonoAgent.ai:

- **PLAYBOOK.md file format** — YAML frontmatter + Markdown body structure
- **Playbook schema** — `name`, `version`, `trigger`, `trigger-patterns`, `parameters`, `steps`, `constraints`, `allowed-tools`, `context-mode`, `tags`, `depends-on`
- **Parameter system** — Typed parameters (`String`, `Number`, `Boolean`, `Array`) with `required`, `default`, `enum`, `min`, `max`, `hint`
- **Step system** — `id`, `requires`, `file`, `inline-prompt`, `script`, `gate`, `output`, `agent`, `playbook`
- **Gate types** — `None`, `Confirm`, `Review`, `Approve`
- **Template variable syntax** — `{{params.<name>}}`, `{{state.<key>}}`, `{{constraints}}`, `{{shell:<cmd>}}`, `{{file:<path>}}`, `{{env.*}}`
- **Context modes** — `Full`, `Selective`, `Fork`
- **Trigger modes** — `Manual`, `Auto`, `Both`
- **Constraint injection** — File-based and inline constraint sets
- **Example playbooks** — `commit`, `release`, `file-scan`, `pr-ready`, `db-migrate`, `deploy-ftp`, `graphify`, `incident-response`
- **Discovery search paths** — `~/.openmono/playbooks/`, `.openmono/playbooks/`, workspace directories

## What We've Added

This project repackages the playbook engine as a standalone **MCP (Model Context Protocol) server**, making it accessible to any MCP-compatible agent (Claude Desktop, Cline, Continue, etc.), not just the OpenMonoAgent.ai TUI/CLI. Our additions include:

- MCP server protocol implementation (stdio transport)
- Tool definitions: `list_playbooks`, `run_playbook`, `resume_playbook`, `get_playbook_state`, `validate_playbook`
- Comprehensive documentation on creating playbooks
- Comparison guide: Playbooks vs. Skills vs. MCP
- This attribution file

## Original Repository

- **Repository:** [https://github.com/StartupHakk/OpenMonoAgent.ai](https://github.com/StartupHakk/OpenMonoAgent.ai)
- **License:** MIT (see [LICENSE](https://github.com/StartupHakk/OpenMonoAgent.ai/blob/main/LICENSE))

## License

This project is also licensed under the MIT License, in keeping with the original project's licensing. See [LICENSE](LICENSE).

---

We are grateful to the OpenMonoAgent.ai contributors for creating and open-sourcing this powerful workflow orchestration system.
