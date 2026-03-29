---
name: browser
label: browser
description: Browser automation for Aliceloop. Use when the user needs to interact with websites - navigating, filling forms, clicking buttons, opening login flows, taking screenshots, or browsing a site step by step.
status: available
mode: instructional
allowed-tools:
  - bash
  - view_image
  - browser_find
  - browser_navigate
  - browser_snapshot
  - browser_wait
  - browser_click
  - browser_type
  - browser_scroll
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

## Browser Runtime

Use the browser tools for:

- unknown sites
- arbitrary page exploration
- login pages, QR codes, captcha handoff, and screenshots
- multi-step navigation where you need to see the current page state
- form filling, clicks, and DOM-driven interaction
- cases where the runtime may internally prefer desktop relay but you do not need to choose that backend yourself

The runtime prefers a visible desktop Chrome relay when it is healthy, and otherwise falls back to the local non-relay browser backend. The tool surface stays the same either way.

### Core Workflow

The browser flow is:

Navigate -> Snapshot/Find -> Scroll if needed -> Interact -> Re-snapshot

```text
browser_navigate(url="https://example.com")
browser_snapshot()
browser_find(query="评论")
browser_scroll(direction="down", amount=1200)
browser_click(ref="...")
browser_type(ref="...", text="...")
browser_snapshot()
```

Treat the returned snapshot as the source of truth after every interaction.
Do not claim a click, type, submit, or navigation has succeeded until the refreshed snapshot shows the expected state.
If the current tab is already the right page, keep reusing it instead of opening a new blank tab.

### Essential Commands

```text
browser_navigate(url="https://example.com")
browser_snapshot()
browser_find(query="发送")
browser_click(ref="...")
browser_type(ref="...", text="...")
browser_scroll(direction="down")
browser_screenshot(analyze=true, prompt="看这张页面截图，告诉我底部输入框、评论框、发送按钮或需要先点开的入口在哪里")
```

If a social site, feed, or video page lazy-loads comments or reply boxes below the fold, do not keep searching the first snapshot forever.
Scroll first, re-snapshot, and only then keep looking for the target composer or send button.
If the DOM snapshot is still unclear, take a screenshot with `analyze=true` or inspect it with `view_image` to decide whether you need to scroll further or open a collapsed panel before continuing with DOM tools.
When asking for screenshot analysis, be explicit: ask where the visible input box or send button is, whether it sits in a bottom-fixed bar, and what the next click should be.

If the task is about understanding a playback page instead of only clicking around it, the same browser session can also expose:

- `browser_find`
- `browser_wait`
- `browser_scroll`
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

When Aliceloop Desktop has a healthy Chrome relay, the browser path can reuse that persistent Chrome session and its login state. When relay is unavailable, the same `browser_*` surface falls back to the local browser backend.

Avoid opening a fresh tab unless the task explicitly needs a separate page. For normal browsing and social-site interactions, work in the current visible tab and verify the resulting page state before moving on.

## Constraints

- For QR login, captcha, or visual verification pages, stay on Aliceloop's native browser tools so you can capture and show the real page.
- Do not make the model choose between relay and another local browser backend. Use the `browser_*` tools and let runtime pick the backend.

## Decision Guide

- Need to automate an arbitrary site from scratch? -> Browser runtime
- Need to click around, fill a form, or take screenshots? -> Browser runtime
- Need a visible login, QR, or captcha handoff? -> Browser runtime
- Need the runtime to reuse desktop Chrome session when available? -> Browser runtime
