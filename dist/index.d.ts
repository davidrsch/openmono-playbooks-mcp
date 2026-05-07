#!/usr/bin/env node
/**
 * OpenMono Playbooks MCP Server
 *
 * Exposes the OpenMono Playbooks workflow orchestration engine
 * to any MCP-compatible agent (Claude Desktop, Cline, Continue, etc.).
 *
 * This server makes playbooks accessible as first-class tools:
 *   - health_check        — Server readiness probe
 *   - list_playbooks      — Discover available playbooks
 *   - run_playbook        — Execute a playbook with typed parameters
 *   - resume_playbook     — Resume an interrupted playbook
 *   - get_playbook_state  — Inspect run state
 *   - validate_playbook   — Validate syntax and parameters
 *
 * Inspired by and derived from OpenMonoAgent.ai by StartupHakk.
 * See: https://github.com/StartupHakk/OpenMonoAgent.ai
 */
export {};
