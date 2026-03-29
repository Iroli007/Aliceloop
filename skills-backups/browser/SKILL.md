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
---

# Browser

One browser capability, multiple internal backends.

| Engine | When to Use | How |
|--------|-------------|-----|
| **Browser Runtime** | Arbitrary sites, form filling, screenshots, login/QR handoff, and normal browsing | `browser_*` tools |
| **Internal Relay Path** | Reuse the visible desktop Chrome session when Aliceloop Desktop relay is healthy | Chosen automatically by runtime |
| **OpenCLI Adapter** | Supported site adapters with structured output and existing Chrome login state | `skills/browser/scripts/opencli` |

## Browser Runtime

Use the browser tools for:

- unknown sites
- arbitrary page exploration
- login pages, QR codes, captcha handoff, and screenshots
- multi-step navigation where you need to see the current page state
- form filling, clicks, and DOM-driven interaction
- cases where the runtime may internally prefer desktop relay but you do not need to choose that backend yourself

The runtime may internally choose a visible desktop Chrome relay when it is healthy, and otherwise fall back to local Playwright. The tool surface stays the same either way.

### Core Workflow

The browser flow is:

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

When Aliceloop Desktop has a healthy Chrome relay, the browser path can reuse that persistent Chrome session and its login state. When relay is unavailable, the same `browser_*` surface falls back to local Playwright.

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
- Do not make the model choose between relay and Playwright. Use the `browser_*` tools and let runtime pick the backend.

## Decision Guide

- Need to automate an arbitrary site from scratch? -> Browser runtime
- Need to click around, fill a form, or take screenshots? -> Browser runtime
- Need a visible login, QR, or captcha handoff? -> Browser runtime
- Need the runtime to reuse desktop Chrome session when available? -> Browser runtime
- Need a supported structured site command? -> OpenCLI
- Need existing Chrome login state on a supported adapter? -> OpenCLI
