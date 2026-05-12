---
name: test-script
version: 1.0.0
description: Test playbook with a script validation step
steps:
  - id: script-step
    inline-prompt: Run the validation script
    script: ./check.sh
    output: script_result
allowed-tools:
  - read_file
---

Test agent with script step.
