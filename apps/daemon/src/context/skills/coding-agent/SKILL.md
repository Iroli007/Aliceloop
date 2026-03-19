---
name: coding-agent
label: coding-agent
description: Focused coding workflow for multi-file edits, debugging, refactors, new features, and repo-aware implementation work inside Aliceloop.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/sub-agents
allowed-tools:
  - sandbox_read
  - sandbox_edit
  - sandbox_write
  - sandbox_bash
---

# Coding Agent

Use this skill when the task is primarily software engineering work inside a local repository.

Examples:

- debugging runtime failures
- editing multiple files coherently
- refactoring an existing module
- implementing a small feature end to end
- updating tests and verifying behavior

## Working loop

1. Inspect first.
   Use fast search (`rg`, `rg --files`) and targeted reads before proposing edits.
2. Narrow the change.
   Prefer the smallest patch that solves the actual problem.
3. Edit deliberately.
   Change only the files that matter and preserve existing project patterns.
4. Verify before claiming success.
   Run the smallest relevant test, typecheck, build, or smoke check available.
5. Report outcome clearly.
   Summarize what changed, what was verified, and any remaining risks.

## Operating rules

- Read the surrounding code before editing.
- Prefer existing abstractions over introducing new ones.
- Avoid destructive git commands unless the user explicitly asks.
- If the repo is dirty, work with the existing changes instead of reverting them.
- When blocked by ambiguity, make the safest reasonable assumption and say what you assumed.
- If verification fails, report the failure honestly and keep the partial fix isolated.

## Editing style

- Keep patches compact and intentional.
- Add comments only when they reduce real confusion.
- Preserve the established naming, file layout, and conventions of the repo.
- When a change spans multiple files, keep the implementation path easy to review.
