---
name: scheduler
description: Create, inspect, and remove scheduled Aliceloop jobs. Use when the user asks for reminders, later follow-ups, or recurring timed tasks.
allowed-tools:
  - bash
  - read
---

# Scheduler Skill

Use Aliceloop's cron commands for reminders and scheduled runs.

## When To Use

Use this skill when the user wants to:

- be reminded later
- schedule a follow-up for a session
- run a recurring check on a time schedule
- inspect or remove an existing scheduled job

## Core Commands

```bash
# List scheduled jobs
aliceloop cron list

# Add a scheduled job
aliceloop cron add "Review reminder" at "2h" \
  --prompt "Remind me to review the patch" \
  --session <session-id>

# Remove a scheduled job
aliceloop cron remove <job-id>
```

## Workflow

1. Use `aliceloop cron list` before editing or deleting an existing job.
2. Use `aliceloop cron add "<name>" at "<schedule>" --prompt "<text>"` to create a new scheduled job.
3. Include `--session <session-id>` when the reminder should target the current conversation.
4. Remove obsolete jobs once the user cancels them.

## Scheduling Notes

- The current Aliceloop CLI supports `cron add <name> at <schedule> --prompt <text> [--session <id>]`.
- Keep prompts short and action-oriented.
- If the user wants multiple recurring jobs, create them one by one and verify with `aliceloop cron list`.
