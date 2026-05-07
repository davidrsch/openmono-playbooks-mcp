---
name: hello
version: 1.0.0
description: A simple test playbook
trigger: manual
parameters:
  name:
    type: String
    required: true
    hint: Your name
  count:
    type: Number
    required: false
    default: 1
    min: 1
    max: 10
  verbose:
    type: Boolean
    required: false
    default: false
steps:
  - id: 01-greet
    description: Greet the user
    inline-prompt: |
      Say hello to {{params.name}}.
      Count: {{params.count}}
      Verbose: {{params.verbose}}
    output: greeting
  - id: 02-goodbye
    description: Say goodbye
    requires: ["01-greet"]
    inline-prompt: |
      Say goodbye to {{params.name}} after greeting: {{state.greeting}}
tags:
  - test
  - simple
---

# System Prompt

You are a friendly test assistant. Greet the user and say goodbye.

Environment: {{env.USER}}
Cwd: {{shell:pwd}}
