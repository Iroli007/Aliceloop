---
name: scheduler
label: scheduler
description: Schedule recurring work, reminders, and periodic checks through the Aliceloop daemon cron service.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Scheduler

Use this skill when the user asks for recurring jobs, reminders, or timed follow-up work.

## Commands

```bash
aliceloop cron list
aliceloop cron add NAME at SCHEDULE --prompt "..."
aliceloop cron remove CRON_ID
```

## Supported Schedules

```bash
# Run every 30 minutes
aliceloop cron add Inbox sweep at "every 30m" --prompt "Review the latest open issues and summarize the blockers."

# Run daily at a local wall-clock time
aliceloop cron add Daily standup at "daily 09:00" --prompt "Summarize what changed since yesterday and what to do next."

# Run weekly on a named weekday
aliceloop cron add Friday review at "weekly fri 16:30" --prompt "Write a short weekly review and identify unfinished work."

# Run once at an absolute time
aliceloop cron add Launch reminder at "2026-03-21T18:00:00-07:00" --prompt "Remind me to verify the release checklist."
```

## Tips

- Use `aliceloop cron list` before creating duplicates.
- Pass `--session SESSION_ID` when the scheduled prompt should always land in a specific thread.
- Prefer clear prompts that are ready to run without extra context.
- `every 10s` is supported for smoke tests and quick verification, but minute/hour/day cadences are usually better for real work.
