---
name: skill-discovery
label: skill-discovery
description: Discover and recommend installed Aliceloop skills from the local catalog when a task needs capability outside the current context.
status: available
mode: instructional
allowed-tools:
  - glob
  - read
  - grep
---

# Skill Discovery

Use this skill when the request goes beyond the currently loaded skills and you need to find the best matching local capability before replying.

Examples:

- the user asks what skills or capabilities are available
- a task needs a domain-specific workflow you do not already have in context
- you need to recommend the closest installed skill without inventing new abilities

## Workflow

1. Check already-loaded skills first. If a matching skill is already present in the prompt, use it directly.
2. Enumerate local skill directories under `apps/daemon/src/context/skills/`.
3. Read candidate `SKILL.md` files and compare their descriptions, examples, and allowed tools.
4. Recommend the best local match and explain why it fits the user's request.
5. If nothing fits, say that clearly instead of pretending a capability exists.

## Search Habits

- Match on user intent, not only keywords.
- Prefer `status: available` skills over planned entries.
- Treat the catalog as local and file-backed; do not suggest remote installation flows from older ecosystems.
- When two skills are close, call out the tradeoff and pick the narrower, more reliable one.

## Aliceloop Status

The catalog is stored directly in `apps/daemon/src/context/skills/`. This skill is for discovery and routing only; it does not install external skills.
