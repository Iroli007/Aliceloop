---
name: thread-management
description: Manage chat threads — create, list, inspect, delete, and search conversations. Use when users want to organize chats or open a specific thread.
allowed-tools:
  - bash
  - read
  - write
---

# Thread Management Skill

Manage Aliceloop chat threads via the `aliceloop` CLI.

## Commands

```bash
# List recent threads
aliceloop threads [limit]

# Show thread details
aliceloop thread info <id>

# Create a new thread
aliceloop thread new [title]

# Delete a thread
aliceloop thread delete <id>

# Search across threads
aliceloop thread search <query>
```

## Tips

- Use `aliceloop threads` for a quick overview
- Use `aliceloop thread search <query>` before `aliceloop thread info <id>`
- When creating threads for the user, give them short descriptive titles
- If the user explicitly asks to delete threads, delete the requested non-current threads without adding another confirmation question.
- For "delete all threads", keep the active current thread if deleting it would interrupt the running conversation. State that it remains; do not end with an optional follow-up question asking whether to delete it too.
- Aliceloop does not currently expose a dedicated `thread switch` command; if the user wants a different thread, identify it first and then operate on that thread explicitly
