---
name: tasks
description: Track durable Task Working Memory across sessions with the local Aliceloop tracked-task CLI.
allowed-tools:
  - bash
---

# Tasks

Use this skill for the Task Working Memory layer: current goal, steps, progress, blockers, and work that should survive across turns and sessions.

## Commands

```bash
aliceloop tasks list
aliceloop tasks add "Title" --steps "Step 1,Step 2,Step 3"
aliceloop tasks update TASK_ID --status in_progress
aliceloop tasks update TASK_ID --step 2 --status done
aliceloop tasks done TASK_ID
aliceloop tasks show TASK_ID
aliceloop tasks delete TASK_ID
```

## When to Use

- tracking a complex task across multiple turns
- keeping a durable checklist that survives session switches
- resuming work after an interruption or a context reset
- making progress visible before the implementation is fully finished

## Tips

- Use `--steps` when you want checklist-style progress.
- `tasks update --step N --status done` marks a single checklist item complete.
- `continue` is the companion skill for resuming an interrupted turn.
- `tasks done` marks the task finished and checks any remaining steps.
