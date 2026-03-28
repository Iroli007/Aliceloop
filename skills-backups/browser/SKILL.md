---
name: browser
label: browser
description: Browser automation for Aliceloop. Use when the user needs to interact with websites - navigating, filling forms, clicking buttons, opening login flows, taking screenshots, or browsing a site step by step. Prefer Aliceloop's native browser tools for arbitrary pages and use OpenCLI only for supported structured site adapters.
status: available
mode: instructional
source-url: https://github.com/jackwener/opencli
allowed-tools:
  - bash
  - browser_navigate
  - browser_snapshot
  - browser_click
  - browser_type
  - browser_screenshot
  - browser_media_probe
  - browser_video_watch_start
  - browser_video_watch_poll
  - browser_video_watch_stop
  - chrome_relay_status
  - chrome_relay_list_tabs
  - chrome_relay_open
  - chrome_relay_navigate
  - chrome_relay_read
  - chrome_relay_read_dom
  - chrome_relay_click
  - chrome_relay_type
  - chrome_relay_screenshot
  - chrome_relay_scroll
  - chrome_relay_eval
  - chrome_relay_back
  - chrome_relay_forward
---

# Browser

Three engines, pick the right one.

| Engine | When to Use | How |
|--------|-------------|-----|
| **Aliceloop Native Browser** | Fresh automation, arbitrary sites, form filling, screenshots, login/QR handoff, any page that needs general interaction | `browser_*` tools |
| **Chrome Relay** | Reading or interacting with attached desktop Chrome relay tabs, especially when you want explicit tab state or readable extraction | `chrome_relay_*` tools |
| **OpenCLI** | Supported site adapters with structured output and existing Chrome login state | `skills/browser/scripts/opencli` |

## Aliceloop Native Browser (Primary Engine)

Use the native browser tools for:

- unknown sites
- arbitrary page exploration
- login pages, QR codes, captcha handoff, and screenshots
- multi-step navigation where you need to see the current page state
- form filling, clicks, and DOM-driven interaction

### Core Workflow

The native browser flow is:

Navigate -> Snapshot -> Interact -> Re-snapshot

```text
browser_navigate(url="https://example.com")
browser_snapshot()
browser_click(ref="...")
browser_type(ref="...", text="...")
browser_snapshot()
```

### Essential Commands

```text
browser_navigate(url="https://example.com")
browser_snapshot()
browser_click(ref="...")
browser_type(ref="...", text="...")
browser_screenshot()
```

If the task is about understanding a playback page instead of only clicking around it, the same browser session can also expose:

- `browser_media_probe`
- `browser_video_watch_start`
- `browser_video_watch_poll`
- `browser_video_watch_stop`

### Ref Lifecycle

Refs returned by `browser_snapshot` are page-state dependent. Re-snapshot after:

- clicking links or buttons that navigate
- form submissions
- dynamic page updates that replace or reorder elements

### Profile Persistence

When Aliceloop Desktop has a healthy Chrome relay, the browser path uses a persistent Chrome session and can reuse login state there. When no relay is available, it falls back to local Playwright.

## Chrome Relay

Use relay tools when the task is about the attached desktop Chrome relay tab itself: reading it, switching tabs, inspecting DOM refs, scrolling, or running a quick page-side expression.

### Essential Commands

```text
chrome_relay_status()
chrome_relay_list_tabs()
chrome_relay_open(url="https://example.com")
chrome_relay_navigate(url="https://example.com")
chrome_relay_read()
chrome_relay_read_dom()
chrome_relay_click(ref="...")
chrome_relay_type(ref="...", text="...")
chrome_relay_screenshot()
chrome_relay_scroll(direction="down")
chrome_relay_eval(expression="document.title")
chrome_relay_back()
chrome_relay_forward()
```

### Relay Notes

- `chrome_relay_read()` is for readable text with metadata.
- `chrome_relay_read_dom()` is for element refs and page structure.
- `chrome_relay_list_tabs()` only lists tabs attached to the Aliceloop relay session.
- If relay is unavailable, these tools fail fast instead of silently falling back.

## OpenCLI (Structured Site Engine)

Use OpenCLI only when the task is clearly a supported, structured command on a known site such as Bilibili, Xiaohongshu, Twitter/X, or Reddit.

It is not the default path for unknown sites or free-form browsing.

### Installation

```bash
npm install -g @jackwener/opencli
```

### Setup

Use the bundled helper script for every invocation:

```bash
skills/browser/scripts/opencli doctor
skills/browser/scripts/opencli list
```

### Essential Commands

```bash
skills/browser/scripts/opencli twitter search "openai" -f json
skills/browser/scripts/opencli bilibili hot --limit 10 -f json
skills/browser/scripts/opencli xiaohongshu search "露营" -f json
```

### Session Persistence

OpenCLI reuses the logged-in Chrome session from its Browser Bridge. Run `skills/browser/scripts/opencli doctor` first when the task depends on OpenCLI.

## Constraints

- For QR login, captcha, or visual verification pages, stay on Aliceloop's native browser tools so you can capture and show the real page.
- If OpenCLI is missing, the helper script will try `npx -y @jackwener/opencli` first and otherwise print the manual install command.
- If a site does not map cleanly to a supported OpenCLI adapter, fall back to the native browser tools.
- If you need attached relay tab state, use `chrome_relay_*` directly instead of pretending OpenCLI is a general browser.

## Decision Guide

- Need to automate an arbitrary site from scratch? -> Aliceloop native browser
- Need to click around, fill a form, or take screenshots? -> Aliceloop native browser
- Need a visible login, QR, or captcha handoff? -> Aliceloop native browser
- Need to read or manipulate an attached desktop relay tab? -> Chrome relay
- Need DOM refs or readable extraction from the relay tab? -> Chrome relay
- Need a supported structured site command? -> OpenCLI
- Need existing Chrome login state on a supported adapter? -> OpenCLI
