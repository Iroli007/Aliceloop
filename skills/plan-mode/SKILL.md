---
name: plan-mode
description: Enter a planning-first workflow with structured steps, checkpoints, and explicit approval before execution.
allowed-tools:
  - bash
---

# Plan Mode

Use this skill when the task should stay in a planning-only workflow before execution begins.

## Commands

```bash
aliceloop plan list
aliceloop plan create "Refactor memory system" --goal "Clarify repository boundaries" --steps "Audit current code,Propose API,Validate migrations"
aliceloop plan show PLAN_ID
aliceloop plan update PLAN_ID --steps "Audit current code,Propose API,Validate migrations,Write smoke tests"
aliceloop plan approve PLAN_ID
aliceloop plan archive PLAN_ID
```

## Workflow

1. Create a draft plan with a clear title, goal, and step list.
2. Refine the plan until the steps are concrete and reviewable.
3. Approve the plan before switching into execution-heavy skills.
4. Archive the plan once it has been superseded or completed.

## Tips

- Keep steps outcome-oriented rather than tool-oriented.
- Use `plan show` after any update so the latest checklist is visible in one place.
- When the user explicitly wants planning only, stay inside this skill and avoid starting implementation work.
