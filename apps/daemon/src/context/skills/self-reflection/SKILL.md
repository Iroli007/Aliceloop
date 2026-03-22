---
name: self-reflection
label: self-reflection
description: Maintain reflective notes and lightweight journaling entries through Aliceloop memory.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Self Reflection

Use this skill for diary-like reflection, retrospective summaries, or long-horizon self-observation.

## Commands

```bash
aliceloop reflect list
aliceloop reflect search "query"
aliceloop reflect add "What I learned today"
aliceloop reflect delete MEMORY_ID
```

## Tips

- Reflection notes are stored as memory entries with source `self-reflection`.
- Use `reflect search` before deleting so the right note is targeted.
- Keep notes concise and insight-focused so they remain useful in later recall.
