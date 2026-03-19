---
name: web-fetch
label: web-fetch
description: Fetch and read web pages, APIs, and online documents when a task requires inspecting a known URL.
status: planned
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_fetch
  - browser.navigate
  - browser.read
---

# Web Fetch

Use this skill when the user already provided a URL or when a later step in research needs the contents of a specific page.

Examples:

- read a docs page
- inspect an API response
- summarize an article
- fetch release notes from a known URL

## Intended workflow

1. Fetch the exact page the user cares about.
2. Extract the main content, not surrounding noise.
3. Preserve the source URL and publication date when relevant.
4. Quote sparingly and summarize the rest.

## Escalation rules

- If the page is login-protected, dynamic, or blocked, switch to the browser skill once browser tooling exists.
- If the task depends on freshness, pair this with the web-search skill so you do not fetch the wrong page.
- If multiple URLs conflict, prefer official or primary sources.

## Aliceloop status

This skill is planned for a future web tool / ACP adapter.

If `web_fetch` is not available yet:

- state that direct web fetching is not installed in the current runtime
- do not fabricate fetched content
- ask the user for the page contents only when there is no safe local fallback
