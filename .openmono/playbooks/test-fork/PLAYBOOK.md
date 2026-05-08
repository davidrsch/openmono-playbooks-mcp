---
name: test-fork
version: 1.0.0
description: A playbook with Fork context mode
trigger: manual
context-mode: Fork
steps:
  - id: only-step
    inline-prompt: Delegate this to a sub-agent
allowed-tools:
  - read_file
---

You are a test agent. Fork mode allows sub-agent delegation.
