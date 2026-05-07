---
name: test-single-step
version: 1.0.0
description: A single-step test playbook
steps:
  - id: step-one
    inline-prompt: Do the only thing
allowed-tools:
  - read_file
---

You are a test agent. Execute the single step.
