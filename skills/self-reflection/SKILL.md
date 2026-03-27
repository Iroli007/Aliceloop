---
name: self-reflection
label: self-reflection
description: Maintain Aliceloop's rolling session summary. Use for current-topic summary, temporary preferences, session conclusions, and lightweight reflection that should help the current conversation without becoming durable profile memory.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Self Reflection Skill

Use this skill for Aliceloop's Session Summary layer.

This layer is for session-scoped information:
- current topic summary
- temporary preferences from this conversation
- conclusions formed in this conversation
- lightweight reflection about what just happened

Do not use this skill for durable profile/fact memory unless the user clearly wants that information remembered across conversations.

## Commands

```bash
aliceloop reflect list
aliceloop reflect search "query"
aliceloop reflect add "What I learned today"
aliceloop reflect delete MEMORY_ID
```

## When to Use

- **You need a rolling summary of the current session**
- **The user establishes temporary preferences for this conversation**
- **The conversation reaches a conclusion that should stay available during this session**
- **You want to record a concise reflection or lesson from the current exchange**

## What Belongs Here

- "In this session, keep answers short and direct"
- "Current topic: redesigning memory skills around explicit tool usage"
- "Conclusion: deep memory should be triggered by skills, not auto-injected"

## What Does Not Belong Here

- stable user profile facts across sessions
- permanent preferences that should live in `memory-management`
- raw thread replay, which belongs to `thread-management`

## Tips

- Reflection notes are stored as memory entries with source `self-reflection`.
- Use `reflect search` before deleting so the right note is targeted.
- Keep notes concise, session-scoped, and insight-focused so they remain useful in later recall.
- Prefer one short actionable summary over many noisy notes.
