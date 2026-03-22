---
name: thread-management
label: thread-management
description: List, inspect, create, and search Aliceloop conversation threads from the CLI.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Thread Management

Use this skill when the user asks about other conversations, thread history, or starting a fresh thread.

## Commands

```bash
aliceloop threads
aliceloop threads 10
aliceloop thread info THREAD_ID
aliceloop thread new "Optional title"
aliceloop thread search "keyword"
aliceloop thread delete THREAD_ID
```

## Tips

- Use `threads` first to discover ids and recent previews.
- Use `thread info` when you need message counts or recent message excerpts.
- Use `thread delete` only when the user explicitly wants a conversation removed.
