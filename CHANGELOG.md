# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-07

### Added

- Initial release of OpenMono Playbooks MCP server
- Eight MCP tools: `health_check`, `list_playbooks`, `run_playbook`, `complete_step`, `skip_step`, `fail_step`, `resume_playbook`, `get_playbook_state`, `validate_playbook`
- Declarative playbook format with YAML frontmatter in PLAYBOOK.md files
- Multi-step workflow engine with topological step ordering (Kahn's algorithm)
- Checkpoint/resume persistence to `~/.openmono/state/`
- Template variable engine supporting `{{params.*}}`, `{{state.*}}`, `{{shell:*}}`, `{{file:*}}`, `{{env.*}}`, `{{constraints}}`
- Rate limiting for protection against excessive tool calls
- Input size guard (1 MiB limit)
- Structured JSON logging to stderr with configurable log levels
- Multi-version Node.js CI matrix (18.x, 20.x, 22.x) with lint, test, and security audit
- Comprehensive documentation including README, COMPARISON, HOW-TO-CREATE-PLAYBOOKS, and PLAYBOOKS reference

[1.0.0]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.0.0
