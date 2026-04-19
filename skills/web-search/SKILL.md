---
name: web-search
description: Search the web for information using the built-in `web_search` tool. Use when users ask questions requiring up-to-date information, research, or fact-checking.
allowed-tools:
  - bash
  - web_search
  - ChromeRelayStatus
---

# Web Search Skill

Search the web using the built-in `web_search` tool. On Aliceloop this is the built-in research path for current information, fact-checking, and source discovery.

## Relay Check

Before searching, check whether Chrome Relay is healthy:

```text
ChromeRelayStatus()
```

- If relay is healthy, keep it available for follow-up pages that may need authenticated browser access later
- If relay is not healthy, continue with `web_search` normally; search itself should not block on relay

## Web Search Tool (Primary)

```text
web_search(query="your search query", max_results=5)
```

- Returns structured results with titles, URLs, snippets, and source metadata
- Works well for up-to-date information, broad research, and fact-checking
- Keep `max_results` small unless the task needs a wider sweep

## Fetching Page Content

After finding URLs from search, route the `web-fetch` skill when the actual page content must be read:

```text
web_fetch(url="https://example.com/article")
```

- Use `web_fetch` through that skill when exact page content matters more than discovery
- Prefer official docs, primary sources, and pages with clear publication dates

## Browser Fallback

If `web_search` or `web_fetch` are not enough because a page needs login, captcha, or multi-step interaction, fall back to the browser skill:

```text
browser_navigate(url="https://example.com")
browser_snapshot()
```

If the page needs clicks, typing, or screenshots, continue with the native browser tools:

```text
browser_click(ref="...")
browser_type(ref="...", text="...")
browser_screenshot()
```

The browser skill prefers a visible Aliceloop Desktop Chrome relay with persistent login state when available, and otherwise falls back to the local browser backend. For supported structured site adapters, the browser path may also use OpenCLI after the native browser path is ruled out.

## Tips

- For complex queries, try multiple search approaches
- Always summarize findings instead of dumping raw results
- For freshness queries like `today`, `latest`, `今天`, or `最新`, use the current runtime year instead of hardcoding a fixed year
- Compare dates and sources when reports conflict
- Search is the discovery layer. If a concrete page matters, follow up with `web_fetch` instead of re-searching forever

## Examples

**"Latest AI news":**

```text
web_search(query="latest AI news <current_year>", max_results=5)
```

**"Python 3.13 new features":**

```text
web_search(query="python 3.13 new features", max_results=5)
```

**Fetch a specific article after search:**

```text
web_fetch(url="https://docs.python.org/3.13/whatsnew/3.13.html")
```
