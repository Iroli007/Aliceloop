---
name: skills-search
label: skills-search
description: Browse the local Aliceloop skill catalog, inspect skill details, and find the right skill for a task.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Skills Search

Use this skill when the user wants to browse the local skill catalog, inspect skill details, or find the best installed skill for a task.

## Commands

```bash
aliceloop skills list
aliceloop skills show browser
aliceloop skills search browser
```

## Tips

- Use `skills search` first when you only know the capability, not the exact skill id.
- `skills show` is the fastest way to inspect allowed tools and the skill's source file.
- This hub currently covers the local daemon catalog only; there is no remote marketplace or third-party install flow.
