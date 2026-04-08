---
name: todo
description: Maintain a per-thread markdown checklist in the workspace. Use when the user wants a lightweight todo list instead of a global tracked task.
allowed-tools:
  - bash
  - read
  - write
---

# Todo Skill

Maintain a thread-local markdown todo file inside the workspace.

## File Location

Use a per-thread file so concurrent chats do not collide:

```text
.aliceloop/todos-<THREAD_ID>.md
```

If the thread id is not available, fall back to:

```text
.aliceloop/todos.md
```

## File Format

```markdown
# Todos

- [x] Fix authentication bug
- [ ] ~Add unit tests~ *(in progress)*
- [ ] Update documentation
- [ ] Write changelog
```

## Status Markers

- `- [ ]` -> pending
- `- [ ] ~Task name~ *(in progress)*` -> currently active
- `- [x]` -> completed

## Workflow

1. Use `bash` to create the folder when needed:

```bash
mkdir -p .aliceloop
```

2. Use `read` to inspect the current todo file.
3. Use `write` to replace the full file with the updated checklist.
4. Keep only one task marked `in progress` at a time.

## Tips

- Use `todo` for lightweight workspace checklists.
- Use `tasks` for global tracked work that should survive across conversations.
- Update the full markdown file each time instead of appending partial fragments.
- Mark completed items immediately so the active task is always obvious.
