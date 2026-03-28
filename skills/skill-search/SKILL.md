---
name: skill-search
description: Search the local Aliceloop skill catalog and reuse installed skills before giving up. Use when the task is beyond the skills already selected for this turn, or when the user asks about capabilities, tools, or missing skills.
allowed-tools:
  - bash
---

# Skill Search

When a task seems beyond your current turn's selected skills, search the local Aliceloop skill catalog before giving up.

## Search Priority

Always check in this order:

1. **Current turn first**: if a matching skill is already selected in the prompt for this turn, just use it.
2. **Local catalog second**: if nothing already selected fits, inspect the installed local skills:

```bash
aliceloop skills list
aliceloop skills search <query>
aliceloop skills show <id>
```

3. **No remote marketplace**: Aliceloop currently exposes a local catalog only. If the needed capability is not in the local catalog, say that clearly instead of inventing a skill.

## When to Use

- The user asks for a capability you may not have in the current turn
- A task fails because no selected skill seems to fit
- The user asks what skills or tools are available
- The user asks why a capability is missing

## Tips

- Prefer reusing installed skills over improvising a fake new capability
- `aliceloop skills search` is the fastest way to find a likely match by capability
- `aliceloop skills show <id>` is the fastest way to inspect a specific skill's description, allowed tools, and source file
