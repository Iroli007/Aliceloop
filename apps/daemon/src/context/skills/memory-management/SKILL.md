---
name: memory-management
label: memory-management
description: Search, add, and delete Aliceloop memory notes through the local CLI.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Memory Management

Use this skill when the user asks to remember something, forget something, or look up prior facts stored in memory.

## Commands

```bash
aliceloop memory list
aliceloop memory search "query"
aliceloop memory add "content to remember"
aliceloop memory delete MEMORY_ID
```

## When to Use

- "remember this"
- "do you remember ..."
- "forget that preference"
- retrieving stored notes before answering a continuity-sensitive question

## Tips

- Search before deleting, so the right note id is removed.
- CLI-created memories are stored as regular Aliceloop memory notes.
- Do not claim a memory exists unless the CLI or context actually shows it.
