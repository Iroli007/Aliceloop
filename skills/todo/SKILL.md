---
name: todo
description: Maintain a lightweight Markdown todo list inside the workspace for longer multi-step work.
allowed-tools:
  - read
  - write
---

# Todo

Use this skill when a task benefits from a persistent checklist in the repo or working directory.

## File

Store todos at `.aliceloop/todos.md` in the current workspace.

## Format

```markdown
# Todos

- [x] Fix authentication bug
- [ ] Add unit tests *(in progress)*
- [ ] Update documentation
```

## Rules

- Read the file before changing it.
- Keep items short and actionable.
- Mark the current step clearly when work is in progress.
