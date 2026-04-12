---
name: tasks
description: Track multi-step work in Aliceloop's global task list shared across threads. Use when the user starts a longer task, wants status tracking, or needs progress updates across turns.
allowed-tools:
  - bash
  - read
---

# Tasks Skill

Use Aliceloop's task tracker for longer multi-step work.

## Scope And Storage

- `tasks` are shared across threads within the same Aliceloop daemon database. They are not thread-local like `todo`.
- `tasks` are not plan-mode drafts. Do not treat a plan as a tracked task unless the user explicitly asks to track it as a task.
- In this project's default setup, tracked tasks are stored in the local daemon database at `apps/.data/aliceloop.db` in the `task_runs` table.
- Because they live in the database, they survive daemon and desktop restarts.
- Open tasks are not automatically injected into every turn's prompt context. If the user refers to ongoing work, list or inspect tasks first instead of assuming the current state from memory.

## When To Use

Use this skill when the user wants to:

- start a complex task with multiple steps
- track work that will span multiple turns or multiple threads
- check progress on ongoing work
- update task status across turns
- list, inspect, or delete tracked tasks

Default rule:

- If the work has 3 or more concrete steps, or is likely to span multiple turns, create a tracked task unless the user clearly wants a lightweight thread-local checklist instead.

## Core Commands

```bash
# List tasks
aliceloop tasks list
aliceloop tasks list all
aliceloop tasks list active
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

## Status Model

- Current tracked-task statuses are `queued`, `running`, `done`, and `failed`.
- There is no native `blocked` status yet.
- When work is blocked, do not invent a `blocked` command status. Update the task detail with a clear blocker note and keep the closest real state:
- use `queued` if work has not started yet
- use `running` if work started and is now waiting on something

Example:

```bash
aliceloop tasks update <task-id> \
  --status running \
  --detail "Blocked: waiting for API credentials from the user. Next action: retry after credentials arrive."
```

## Thread Association

- Conceptually, tasks are global and may still refer back to a specific thread.
- The current tracked-task API supports optional `sessionId` linkage, but the `aliceloop tasks ...` CLI shown here does not currently expose a dedicated `--thread` or `--session` flag.
- Do not claim that `aliceloop tasks add --thread <threadId>` already exists.
- If thread linkage matters while using the current CLI, include the relevant thread id or thread title in `--detail`.

## Workflow

1. List existing tasks first if the user may be referring to ongoing work.
2. Create a tracked task for work with 3 or more concrete steps, or work likely to span multiple turns.
3. Update status and completed steps as the work progresses.
4. If the work becomes blocked, record the blocker explicitly in `--detail`.
5. Mark tasks done promptly so stale tasks do not accumulate.

## Tips

- Keep task titles short and distinct.
- Use `--detail` for the user-facing purpose of the task.
- Use `--steps` only when the task truly needs milestone tracking.
- For "活跃任务", use `aliceloop tasks list active`. It returns running plus queued tracked tasks.
- For "当前任务" or "正在做什么", prefer `aliceloop tasks list active` before answering from memory.
- If the user's request sounds thread-local and lightweight, prefer `todo` instead of `tasks`.
- Prefer `tasks` for global progress tracking; use `todo` for local workspace checklists.
