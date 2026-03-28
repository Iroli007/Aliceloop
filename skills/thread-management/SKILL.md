---
name: thread-management
label: thread-management
description: Manage chat threads — create, list, inspect, and delete conversations. Use when users want to organize chats or open a specific thread after recall search found it.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Thread Management Skill

Manage Aliceloop chat threads via the `aliceloop` CLI.

This skill is for thread objects, not general durable memory recall. If the user starts with "do you remember" or wants broad recall across prior wording, begin with `memory-management`.

## Tools

```bash
# List recent threads
aliceloop threads [limit]

# Search across thread messages
aliceloop thread search "<query>"

# Show thread details
aliceloop thread info <id>

# Create a new thread
aliceloop thread new [title]

# Delete a thread
aliceloop thread delete <id>
```

## When to Use

- **User wants recent thread overview**
- **User wants to inspect one specific thread**
- **User wants to create or delete a thread**
- **Recall search already found candidate threads and you need original thread context**

## How This Differs From Fact Memory

- `thread-management` answers: "which thread should I open, and what is inside it?"
- `memory-management` answers: "what do I know, and what past wording can I recall quickly?"

If a question mixes both, use both skills:
- memory recall for fast matching
- thread inspection for exact thread evidence

## Tips

- Use `aliceloop threads` for a quick overview.
- Use `aliceloop thread search` before `aliceloop thread info`; do not guess thread ids.
- Treat thread history as raw evidence, not as the source of stable truth.
- If search is ambiguous, prefer the most recent relevant thread and say when you are inferring rather than quoting directly.
