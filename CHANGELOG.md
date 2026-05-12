# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-05-12

### Added

- **SKILL.md**: Bundled agent skill file that teaches any MCP-compatible agent the playbook execution protocol. Agents now know to call `run_playbook` → execute step → `complete_step` rather than reading `PLAYBOOK.md` as a static file.
- **Agent protocol instructions in tool responses**: `formatStepContext`, `list_playbooks`, and `match_playbook` responses now include prominent, hard-to-miss protocol instructions telling the agent to execute playbooks through MCP tools. Every step response starts with a `⚠️ PLAYBOOK PROTOCOL — MANDATORY` block with the exact `runId` and next tool to call.

### Changed

- **`formatStepContext`**: Restructured response format — protocol instructions now appear FIRST (above the step content) with bold, emoji-highlighted call-to-actions including the literal `runId`. Gate instructions are now inline with actionable next steps.

### Fixed

- **Agents treating `PLAYBOOK.md` as a static file to read**: Without proper instructions, agents would discover `PLAYBOOK.md` and just read it with `read_file`, never actually executing the workflow. Now both the SKILL.md (proactive) and tool response formatting (reactive) ensure agents drive the `run_playbook → complete_step` loop.

## [1.2.0] - 2026-05-12

### Added

- **Shell script validation**: Steps with a `script` field now execute the script before completion. Non-zero exit codes fail the step; stdout is captured as the step output.
- **Configurable `max_retries` on steps**: New `max_retries` field on `PlaybookStep` type (defaults to 3) replaces the hardcoded retry limit.
- **Enhanced sub-playbook prompts**: `getCurrentStepContext` now generates rich sub-playbook prompts that include inherited parent state as JSON, explicit `run_playbook` call instructions, and `subRunIds` tracking on the run state.
- **New fixtures**: `test-script` (with `check.sh`), `test-sub-playbook` for testing script execution and sub-playbook prompt generation.
- **New tests**: Script execution tests (cross-platform with graceful shell-not-found handling) and sub-playbook prompt generation tests.

### Fixed

- **`list_playbooks` not discovering project-local playbooks in production**: When VS Code spawns the MCP stdio server as a child process, `process.cwd()` is not the user's project root. Fixed by injecting `WORKSPACE_ROOTS` env var from `extension.ts` → `resolveMcpServerDefinition` and adding a `WORKSPACE_ROOTS` search step in `loader.ts` → `resolveSearchPaths`.
- **`match_playbook` tool not registered**: The handler existed but was missing from `ListToolsRequestSchema`'s tools array. Now properly registered with full input schema.
- **`dist/` untracked from git**: Build artifacts no longer clutter the repository. `dist/` is produced by `npm run build`.

## [1.1.1] - 2026-05-12

### Fixed

- **Runtime `ERR_MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk`**: The MCP server failed to start with `Cannot find package '@modelcontextprotocol/sdk'` when installed as a VS Code extension because `vsce package --no-dependencies` stripped `node_modules`. Fixed by adding an esbuild bundling step that inlines all dependencies into a self-contained `dist/index.js` bundle.
- **`exports` field ordering in `package.json`**: Moved the `types` condition before `import`/`require` to fix an esbuild warning.

### Changed

- Build pipeline now runs `tsc && node esbuild.config.js` instead of just `tsc`.
- Added `esbuild` as a dev dependency.

## [1.1.0] - 2026-05-08

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
- **VS Code MCP server definition provider**: Registers as a native VS Code MCP server via `contributes.mcpServerDefinitionProviders`
- **VS Code extension entry point** (`src/extension.ts`): Activates on startup and registers playbooks-mcp as an MCP server definition provider
- **New error codes**: `GATE_NOT_ACKNOWLEDGED`, `STEP_TIMED_OUT`, `MAX_RETRIES_EXCEEDED`, `CIRCULAR_DEPENDENCY`
- **VS Code Install badges** in README (Marketplace + Open VSX)
- New test suites: `errors.test.ts`, `index.test.ts` (E2E via stdio), `loader.disk.test.ts`, `logger.test.ts`

### Changed

- `startRun`, `completeCurrentStep`, `skipCurrentStep`, and `resumeRun` are now async functions
- `StepResult` type extended with `retryCount` and `subRunId` fields
- Error codes enum extended with 4 new values
- `package.json` restructured: `main` → `dist/extension.js`, `exports./server` → `dist/index.js` for stdio
- Updated README tool table with all 11 MCP tools

### Added Tests

- Trigger pattern matching tests (`trigger.test.ts`)
- Gate enforcement tests (pause, acknowledge, reject without gate)
- Auto-retry and timeout behavior tests
- Context mode variant tests
- Circular dependency detection tests
- Concurrent execution tests
- Checkpoint persistence tests

## [1.0.3] - 2026-05-08

### Added

- New test suites: `errors.test.ts`, `index.test.ts` (E2E via stdio), `loader.disk.test.ts`, `logger.test.ts`

### Changed

- Updated PAT for publishing workflow

## [1.0.2] - 2026-05-08

### Fixed

- Add `icon` field to `package.json` for marketplace logo display

## [1.0.1] - 2026-05-07

### Changed

- Version bump for marketplace release

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

[1.2.0]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.2.0
[1.1.1]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.1.1
[1.1.0]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.1.0
[1.0.3]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.0.3
[1.0.2]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.0.2
[1.0.1]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.0.1
[1.0.0]: https://github.com/davidrsch/playbooks-mcp/releases/tag/v1.0.0
[Unreleased]: https://github.com/davidrsch/playbooks-mcp/compare/v1.2.0...HEAD
