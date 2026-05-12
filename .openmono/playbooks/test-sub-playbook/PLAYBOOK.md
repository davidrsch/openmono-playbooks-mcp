---
name: test-sub-playbook
version: 1.0.0
description: A playbook whose step invokes a sub-playbook
steps:
  - id: step-one
    inline-prompt: Prepare context
    output: sub_context
  - id: step-two
    playbook: test-minimal
    output: sub_result
allowed-tools:
  - read_file
---

Test agent with sub-playbook step.
