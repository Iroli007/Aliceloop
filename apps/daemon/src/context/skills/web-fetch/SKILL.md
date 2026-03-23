---
name: web-fetch
label: web-fetch
description: Fetch and read web pages, APIs, and online documents when a task requires inspecting a known URL.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_fetch
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

- If Aliceloop Desktop has a healthy browser relay, `web_fetch` can read through the visible desktop Chrome path before falling back to raw HTTP.
- If the page is login-protected, highly interactive, or needs multi-step manipulation, switch to the browser skill.
- If the task depends on freshness, pair this with the web-search skill so you do not fetch the wrong page.
- If multiple URLs conflict, prefer official or primary sources.

## Aliceloop status

The `web_fetch` tool is active.

Runtime behavior:

- Desktop relay available: open a temporary visible Chrome tab, load the page, extract readable content, then close the tab
- No relay available: fall back to direct HTTP fetch and HTML-to-Markdown extraction

Limitations:

- Login-protected pages still require the browser skill for interactive auth flows
- Response is capped at 50K characters to protect context budget
- 15-second timeout per request
