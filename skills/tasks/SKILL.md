---
name: tasks
description: Track multi-step work in Aliceloop's global task list. Use when the user starts a longer task, wants status tracking, or needs progress updates across turns.
allowed-tools:
  - bash
  - read
---

# Tasks Skill

Use Aliceloop's task tracker for longer multi-step work.

## When To Use

Use this skill when the user wants to:

- start a complex task with multiple steps
- check progress on ongoing work
- update task status across turns
- list, inspect, or delete tracked tasks

## Core Commands

```bash
# List tasks
aliceloop tasks list
aliceloop tasks list all
aliceloop tasks list running
aliceloop tasks list queued
aliceloop tasks list done

# Create a task
aliceloop tasks add "Build People settings page" \
  --detail "Track the full implementation rollout" \
  --steps "Design API,Build backend,Build frontend,Verify,Ship"

# Show one task
aliceloop tasks show <task-id>

# Update task metadata or progress
aliceloop tasks update <task-id> \
  --title "Revised title" \
  --detail "Updated detail" \
  --steps "Step one,Step two,Step three"

aliceloop tasks update <task-id> --status running
aliceloop tasks update <task-id> --step 2 --step-status done

# Mark done
aliceloop tasks done <task-id>

# Delete
aliceloop tasks delete <task-id>
```

## Workflow

1. List existing tasks first if the user may be referring to ongoing work.
2. Create a tracked task for multi-step work that will span multiple turns.
3. Update status and completed steps as the work progresses.
4. Mark tasks done promptly so stale tasks do not accumulate.

## Tips

- Keep task titles short and distinct.
- Use `--detail` for the user-facing purpose of the task.
- Use `--steps` only when the task truly needs milestone tracking.
- Prefer `tasks` for global progress tracking; use `todo` for local workspace checklists.
