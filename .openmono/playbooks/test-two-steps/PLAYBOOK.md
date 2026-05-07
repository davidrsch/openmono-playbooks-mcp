---
name: test-two-steps
version: 1.0.0
description: A two-step test playbook
steps:
  - id: step-one
    inline-prompt: Step 1
  - id: step-two
    inline-prompt: Step 2
allowed-tools:
  - read_file
---

You are a test agent.
