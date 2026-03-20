---
name: coding-agent
label: coding-agent
description: Focused coding workflow for multi-file edits, debugging, refactors, new features, and repo-aware implementation work inside Aliceloop.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/sub-agents
allowed-tools:
  - sandbox_grep
  - sandbox_glob
  - sandbox_read
  - sandbox_edit
  - sandbox_write
  - sandbox_bash
  - coding_agent_run
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
- If the task needs lightweight automation glue, create a temporary helper script with `sandbox_write` / `sandbox_edit`, run it with `sandbox_bash`, and keep it disposable.
- Do not treat helper scripts as new tools, and do not expand the agent-loop primitive set when the six core abilities are enough.
- When blocked by ambiguity, make the safest reasonable assumption and say what you assumed.
- If verification fails, report the failure honestly and keep the partial fix isolated.

## Editing style

- Keep patches compact and intentional.
- Add comments only when they reduce real confusion.
- Preserve the established naming, file layout, and conventions of the repo.
- When a change spans multiple files, keep the implementation path easy to review.

## Delegation strategy

- For complex tasks spanning 3+ files, or tasks requiring deep multi-step reasoning, delegate to `coding_agent_run` with a clear task description.
- For simple edits (single file, small patches), use the sandbox tools directly.
- Always review the sub-agent's output before reporting success.
