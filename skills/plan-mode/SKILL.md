---
name: plan-mode
description: Create and manage structured implementation plans before execution. Use when the user asks for a plan, phased rollout, or approval-ready step breakdown.
allowed-tools:
  - bash
  - read
---

# Plan Mode Skill

Use Aliceloop's plan records to structure work before execution.

## When To Use

Use this skill when the user wants to:

- make a plan before coding
- break work into phases or milestones
- review or refine an existing plan
- approve or archive a completed plan

## Core Commands

```bash
# List plans
aliceloop plan list
aliceloop plan list all
aliceloop plan list approved
aliceloop plan list archived

# Create a draft plan
aliceloop plan create "Add People settings page" \
  --goal "Ship the first usable settings surface for People" \
  --steps "Define API,Build backend,Build frontend,Verify behavior"

# Inspect a plan
aliceloop plan show <plan-id>

# Update title, goal, or steps
aliceloop plan update <plan-id> \
  --title "Revised title" \
  --goal "Updated goal" \
  --steps "Step one,Step two,Step three"

# Mark approved
aliceloop plan approve <plan-id>

# Archive an old plan
aliceloop plan archive <plan-id>
```

## Workflow

1. Start with `aliceloop plan list` if the user may already have a related draft.
2. Create a new draft when the request clearly needs a fresh plan.
3. Keep steps concrete and ordered.
4. Use `read` on any referenced local files if the plan depends on repository context.
5. Approve or archive the plan once it is settled.

## Tips

- Prefer one concise plan per user-facing initiative.
- Keep steps short, actionable, and easy to verify.
- Use draft plans for exploration; approve only when the direction is settled.
- If the user wants execution immediately, keep the plan short and move on to the actual work.
