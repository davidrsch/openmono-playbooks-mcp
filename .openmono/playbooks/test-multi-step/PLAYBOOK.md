---
name: test-multi-step
version: 1.0.0
description: A multi-step test playbook
steps:
  - id: step-one
    inline-prompt: Step 1 - do the first thing
  - id: step-two
    inline-prompt: Step 2 - do the second thing
  - id: step-three
    inline-prompt: Step 3 - do the final thing
allowed-tools:
  - read_file
---

You are a test agent. Execute each step in order.
