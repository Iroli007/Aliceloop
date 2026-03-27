---
name: browser
label: browser
description: Browser automation for AI agents. Use when the task needs real page interaction, login/session persistence, or Chrome-session-backed `opencli` commands.
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

Use this skill for tasks that require a real browser session rather than raw HTTP.

Examples:

- multi-step website navigation
- login-protected pages
- form filling and submission
- clicking menus, tabs, and modal flows
- account interactions such as comments, likes, follows, and post submission after the user explicitly asks for them
- browsing social feeds, timelines, recommendation streams, creator homepages, videos, and posts while logged in
- taking screenshots for verification
- extracting content from dynamic SPAs
- using `opencli` for Chrome-session-backed site commands

## Runtime

Use `scripts/opencli` when a command already exists in the OpenCLI registry.
Use the native browser tools when you need direct page control inside Aliceloop.

## Login

- Chrome must already be logged into the target site.
- OpenCLI browser commands reuse that Chrome login session.
- If a site is not logged in, open Chrome manually, sign in, then rerun `scripts/opencli`.

## Command Guide

```bash
scripts/opencli list
scripts/opencli doctor
scripts/opencli bilibili hot --limit 5
scripts/opencli bilibili search "rust"
scripts/opencli xiaohongshu search "美食"
scripts/opencli twitter timeline --limit 20
scripts/opencli gh pr list --limit 5
scripts/opencli docker ps
```

## Aliceloop Browser Tools

When you need in-process page interaction, use the browser tools below:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_media_probe`
- `browser_video_watch_start`
- `browser_video_watch_poll`
- `browser_video_watch_stop`

## Guardrails

- Use snapshots for page state.
- After a page change, re-snapshot before trusting the result.
- For login, CAPTCHA, SMS, or 2FA, let the user take over the visible browser window.
- If the user asks for a QR code, capture the real page with `browser_screenshot`.
- For video content, open the actual playback page and use the watch tools.
- For comments, likes, follows, reposts, or post submission, require explicit user request.

## Aliceloop status

This skill is active.

Runtime behavior:

- On Aliceloop Desktop with a healthy browser relay, it controls a visible Google Chrome window through the local desktop relay.
- Outside Desktop, or when no healthy relay is registered, it falls back to the local Playwright adapter.

Available tools:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_media_probe`
- `browser_video_watch_start`
- `browser_video_watch_poll`
- `browser_video_watch_stop`

Current limitations:

- each Aliceloop session binds to one browser tab at a time, so refresh snapshots after page-changing actions
- desktop relay uses an Aliceloop-managed Chrome profile, not the user's personal Chrome profile
- login state persists inside the Aliceloop-managed Chrome profile, so logging into Bilibili, Douyin, X/Twitter, or other sites once lets later browser tasks reuse that session
- this is intended to be platform-agnostic: the same browser workflow covers Bilibili, Douyin, X/Twitter, Weibo, and similar sites
- Playwright fallback still requires local Playwright browsers; if Chromium is missing, run `npx playwright install chromium`
