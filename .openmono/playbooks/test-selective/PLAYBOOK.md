---
name: test-selective
version: 1.0.0
description: A playbook with Selective context mode
trigger: manual
context-mode: Selective
steps:
  - id: only-step
    inline-prompt: Do the thing
allowed-tools:
  - read_file
---

This body should NOT appear in Selective mode.
