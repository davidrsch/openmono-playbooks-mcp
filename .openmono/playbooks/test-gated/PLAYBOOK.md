---
name: test-gated
version: 1.0.0
description: A playbook with a gated step for testing gate behavior
steps:
  - id: step-one
    inline-prompt: Do something that needs approval
    gate: Confirm
allowed-tools:
  - read_file
---

You are a test agent.
