---
name: web-fetch
description: Fetch and read a known URL, API response, or document. Use when exact page content matters more than discovery.
allowed-tools:
  - Bash
  - WebFetch
  - ChromeRelayNavigate
  - ChromeRelayRead
  - ChromeRelayReadDom
  - ChromeRelayListTabs
  - ChromeRelayClick
  - ChromeRelayScreenshot
  - ChromeRelayScroll
  - ChromeRelayEval
---

# Web Fetch

Fetch web content using the best available method, in priority order.

## 1. Chrome Relay (Primary - always try this first)

Use the desktop Chrome relay tools for all web fetching when you need authenticated state, live rendering, or explicit tab control.

```text
chrome_relay_status()
chrome_relay_list_tabs()
chrome_relay_open(url="https://example.com")
chrome_relay_navigate(url="https://x.com/notifications")
chrome_relay_read()
chrome_relay_read_dom()
chrome_relay_click(ref="...")
chrome_relay_screenshot()
chrome_relay_scroll(direction="down")
chrome_relay_eval(expression="document.title")
```

Always start with Chrome relay when the page may depend on:

- authenticated pages such as Twitter/X, GitHub, Google, or webmail
- JavaScript-rendered SPAs
- pages behind login walls
- pages that need clicks, screenshots, scrolling, DOM inspection, or multi-step interaction

## 2. Web Fetch Tool (Fallback for simple/public pages)

If Chrome relay is unavailable, or the page is simple public content, fall back to `web_fetch`:

```text
web_fetch(url="https://example.com/article")
```

- Renders public pages into readable text
- Good for articles, docs, APIs, release notes, and simple public content
- No login/session capability

## Browser Skill

If the task becomes full browser automation rather than tab reading, switch to the browser skill. That path can use native `browser_*` tools for arbitrary pages or OpenCLI for supported structured site adapters.

## Tips

- Chrome relay first when login state or live browser state matters.
- Check `chrome_relay_list_tabs()` first if you expect an existing relay tab.
- Use `chrome_relay_read()` for readable text and `chrome_relay_read_dom()` when you need refs or DOM structure.
- Use `web_fetch` only for simple/public pages when relay is unnecessary or unavailable.
- If you do not already have a concrete URL, go back to `web_search`.
