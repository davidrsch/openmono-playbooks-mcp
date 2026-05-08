# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Human-in-the-loop gate enforcement**: Gated steps (Confirm, Review, Approve) now pause the run until explicitly acknowledged via the new `acknowledge_gate` MCP tool
- **Trigger pattern matching engine** (`src/trigger.ts`): Glob/wildcard pattern matching with weighted scoring for auto-triggering playbooks from user input
- **New MCP tool: `match_playbook`**: Find playbooks matching user input using trigger patterns
- **New MCP tool: `acknowledge_gate`**: Acknowledge a paused gate and advance the playbook run
- **Auto-retry support**: Steps with `auto_retry: true` automatically retry on failure up to 3 times
- **Step timeout enforcement**: Steps with a configured `timeout` (seconds) auto-fail if they exceed the limit
- **Context mode support**: `Full`, `Selective`, and `Fork` context modes are now applied in step prompts
- **Circular dependency detection**: `depends-on` chains are validated for circular references
- **Async mutex with LRU eviction**: Replaced spinlock with a proper async-safe mutex; active runs cache evicts completed/failed runs when exceeding capacity (configurable via `MAX_ACTIVE_RUNS` env var)
- **New error codes**: `GATE_NOT_ACKNOWLEDGED`, `STEP_TIMED_OUT`, `MAX_RETRIES_EXCEEDED`, `CIRCULAR_DEPENDENCY`

### Changed

- `startRun`, `completeCurrentStep`, `skipCurrentStep`, and `resumeRun` are now async functions
- `StepResult` type extended with `retryCount` and `subRunId` fields
- Error codes enum extended with 4 new values for gate, timeout, retry, and circular dependency scenarios

### Added Tests

- Trigger pattern matching tests (`trigger.test.ts`)
- Gate enforcement tests (pause, acknowledge, reject without gate)
- Auto-retry and timeout behavior tests
- Context mode variant tests
- Circular dependency detection tests

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
[Unreleased]: https://github.com/davidrsch/playbooks-mcp/compare/v1.0.0...HEAD
