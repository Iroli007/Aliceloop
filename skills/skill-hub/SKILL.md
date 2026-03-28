---
name: skill-hub
description: Search, inspect, and manage Aliceloop skills from the local catalog. Use when the user needs a capability the current turn may not have yet, or when you need to browse available skills before deciding what to do.
allowed-tools:
  - bash
  - read
  - write
---

# Skill Hub

Discover and inspect Aliceloop skills to extend the current turn with the right capability.

## Search for Skills

```bash
# Search the local skill catalog
aliceloop skills search <query>

# Examples:
aliceloop skills search weather
aliceloop skills search memory
aliceloop skills search screenshot
```

## Inspect Installed Skills

```bash
# List installed local skills
aliceloop skills list

# Show one skill in detail
aliceloop skills show screenshot
```

## When to Use

- The user asks what Aliceloop can do
- The current turn may be missing the right skill
- You want to inspect a skill before using it
- A task feels beyond the currently selected skills and you need to search the local catalog

## Self-Check Flow

1. The task seems beyond the currently selected skills
2. Search the local catalog with `aliceloop skills search <query>`
3. Inspect likely matches with `aliceloop skills show <id>`
4. Use the matching installed skill on the next step

## Tips

- This hub currently covers the local Aliceloop catalog only; there is no remote marketplace or install flow yet
- `aliceloop skills search` is the best first step when you know the capability but not the exact skill id
- `aliceloop skills show` is the fastest way to inspect the skill description, allowed tools, and source path
