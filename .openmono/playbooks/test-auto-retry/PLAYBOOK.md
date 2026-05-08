---
name: test-auto-retry
version: 1.0.0
description: A playbook with auto_retry enabled for testing retry behavior
steps:
  - id: retry-step
    inline-prompt: Do something that may fail
    auto_retry: true
allowed-tools:
  - read_file
---

You are a test agent. This step has auto_retry enabled.
