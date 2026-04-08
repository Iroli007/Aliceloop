---
name: web-search
description: Search the web for information using the built-in `web_search` tool. Use when users ask questions requiring up-to-date information, research, or fact-checking.
allowed-tools:
  - bash
  - web_search
  - web_fetch
---

# Web Search Skill

Search the web using the built-in `web_search` tool. On Aliceloop this is the built-in research path for current information, fact-checking, and source discovery.

## Web Search Tool (Primary)

```text
web_search(query="your search query", max_results=5)
```

- Returns structured results with titles, URLs, snippets, and source metadata
- Works well for up-to-date information, broad research, and fact-checking
- Keep `max_results` small unless the task needs a wider sweep

## Fetching Page Content

After finding URLs from search, use `web_fetch` to read the actual page content:

```text
web_fetch(url="https://example.com/article")
```

- Use it when exact page content matters more than discovery
- Prefer official docs, primary sources, and pages with clear publication dates

## Browser Fallback

If `web_search` or `web_fetch` are not enough because a page needs login, captcha, or multi-step interaction, fall back to the browser skill:

```text
use_skill(skill="browser")
```

Then follow the browser skill's CLI workflow with `bash` and inspect outputs/files with `read`:

```text
pinchtab nav https://example.com
pinchtab snap -i
```

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
