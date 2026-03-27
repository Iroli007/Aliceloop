---
name: web-fetch
label: web-fetch
description: Fetch and read a known URL, API response, or document. Use when exact page content matters more than discovery.
status: available
mode: instructional
source-url: https://docs.anthropic.com/en/docs/claude-code/settings
allowed-tools:
  - web_fetch
---

# Web Fetch

Use the built-in `web_fetch` tool to read a known URL.

Call `web_fetch` with a concrete URL that you already found, and ask for the main page content when needed. For example, fetch `https://example.com/article` after `web_search` has already found it.

`web_fetch` is the reading layer, not the discovery layer.

## Good fits

- read a docs page
- inspect an API response
- summarize an article
- fetch release notes from a known URL

## Browser Fallback

If the page is login-protected, highly interactive, or needs multi-step manipulation, switch to the browser skill.

## Tips

- Keep the main content, URL, and publication date when relevant.
- Quote sparingly and summarize the rest.
- If you do not already have a concrete URL, go back to `web_search`.
- Prefer official or primary sources when URLs conflict.
