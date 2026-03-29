---
name: web-fetch
description: Fetch and read a known URL, API response, or document. Use when exact page content matters more than discovery.
allowed-tools:
  - Bash
  - WebFetch
---

# Web Fetch

Fetch known URLs with one reading tool. If the task becomes interactive, switch to the browser skill.

## 1. Web Fetch Tool

Use `web_fetch` when you already have a concrete URL and the job is to read the page, not drive the browser.

```text
web_fetch(url="https://example.com/article")
```

- Renders public pages into readable text
- Good for articles, docs, APIs, release notes, and simple public content
- Best when you want page content rather than interactive control

## Browser Skill

If the task needs login state, scrolling, clicking, screenshots, DOM refs, or step-by-step interaction, switch to the browser skill. That path keeps one `browser_*` surface and lets runtime choose relay or Playwright internally.

## Tips

- Use `web_fetch` for known URLs and content reads.
- Use the browser skill when the page depends on login state or interaction.
- Do not make the model choose between relay and Playwright at the tool level.
- If you do not already have a concrete URL, go back to `web_search`.
