---
name: test-minimal
version: 1.0.0
description: A minimal test playbook for executor integration tests
steps:
  - id: step-one
    inline-prompt: Do something simple
    gate: Confirm
allowed-tools:
  - read_file
  - execute_command
---

You are a test agent. Execute the step as described.
