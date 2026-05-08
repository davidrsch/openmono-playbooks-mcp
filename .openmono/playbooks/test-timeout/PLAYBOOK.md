---
name: test-timeout
version: 1.0.0
description: A playbook with timeout configured for testing timeout behavior
steps:
  - id: timed-step
    inline-prompt: Do something that must complete quickly
    timeout: 60
allowed-tools:
  - read_file
---

You are a test agent. This step will timeout if it takes too long.
