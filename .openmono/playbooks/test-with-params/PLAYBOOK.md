---
name: test-with-params
version: 1.0.0
description: A playbook with typed parameters
parameters:
  message:
    type: String
    required: true
  count:
    type: Number
    default: 1
  enabled:
    type: Boolean
    default: false
  tags:
    type: Array
    default: []
steps:
  - id: step-one
    inline-prompt: Process {{params.message}}
allowed-tools:
  - read_file
---

You are a test agent. Your message is: {{params.message}}
