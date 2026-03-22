---
name: browser
label: browser
description: Browser automation for AI agents. Use when the user needs navigation, clicking, form filling, extraction, screenshots, or other real browser interaction.
status: available
mode: instructional
source-url: https://github.com/lackeyjb/playwright-skill
allowed-tools:
  - browser_navigate
  - browser_snapshot
  - browser_click
  - browser_type
  - browser_screenshot
---

# Browser

Use this skill for tasks that require a real browser session rather than raw HTTP.

Examples:

- multi-step website navigation
- login-protected pages
- form filling and submission
- clicking menus, tabs, and modal flows
- taking screenshots for verification
- extracting content from dynamic SPAs

## Intended workflow

1. Navigate to the page or tab you need.
2. Capture a structured snapshot of the current page state.
3. Interact with stable element references instead of guessing visual positions.
4. Re-snapshot after any action that changes the page.
5. Summarize what changed and capture evidence when needed.

## Guardrails

- Prefer DOM or accessibility snapshots over image-only reasoning.
- Re-read the page after navigation, form submission, or modal changes.
- Do not claim a click or submission succeeded unless a fresh snapshot confirms it.
- When a task touches money, auth, or destructive settings, pause for explicit user confirmation.

## Aliceloop status

This skill is active through the local Playwright adapter.

Available tools:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_screenshot`

Current limitations:

- runs a single shared headless Chromium page per live agent context
- element refs come from `browser_snapshot`, so refresh the snapshot after page-changing actions
- the local machine still needs Playwright browsers installed; if Chromium is missing, run `npx playwright install chromium`
