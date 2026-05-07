---
name: test-state-output
version: 1.0.0
description: A playbook that tests state output tracking across steps
steps:
  - id: step-one
    inline-prompt: Compute a value
    output: step-one_output
  - id: step-two
    inline-prompt: Use computed value {{state.step-one_output}}
allowed-tools:
  - read_file
---

You are a test agent. Track state across steps.
