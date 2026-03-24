---
name: browser
label: browser
description: Browser automation for AI agents. Use when the user needs navigation, clicking, form filling, extraction, screenshots, or other real browser interaction.
status: available
mode: instructional
source-url: https://github.com/lackeyjb/playwright-skill
allowed-tools:
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

## Intended workflow

1. Navigate to the page or tab you need.
2. Capture a structured snapshot of the current page state.
3. Interact with stable element references instead of guessing visual positions.
4. Re-snapshot after any action that changes the page.
5. Summarize what changed and capture evidence when needed.
6. If a site needs login, use the visible browser flow and continue in the same relay profile after login succeeds.
7. If the user needs to scan a QR code or complete login manually, capture the real current page with `browser_screenshot` before you ask them to take over.
8. If the user explicitly wants only the QR code image, use `browser_snapshot` to find the QR `img` / `canvas` / `svg` ref, then call `browser_screenshot` with that `ref` so you send only the QR area.
9. If the user asks you to watch, inspect, or analyze a video on a website, do not stop at the homepage, feed, or search results. Click through into the concrete video detail/playback page first, confirm you are on the player page, and only then summarize what you see.
10. Once you are on the playback page, use `browser_media_probe` to confirm the real player, then use `browser_video_watch_start` / `browser_video_watch_poll` instead of guessing from one static screenshot.
11. If the user says “继续看”, “再听听”, “后面讲了什么”, or similar follow-ups, reuse the existing watch session for that player instead of starting from scratch.

## Guardrails

- Prefer DOM or accessibility snapshots over image-only reasoning.
- Re-read the page after navigation, form submission, or modal changes.
- Do not claim a click or submission succeeded unless a fresh snapshot confirms it.
- For video understanding, prefer the watch-session tools over ad-hoc screenshot-only guessing.
- When a task touches money, auth, or destructive settings, pause for explicit user confirmation.
- For login walls, CAPTCHA, SMS codes, or 2FA, pause and let the user take over the visible browser window. Continue after the user confirms login is complete.
- Never fabricate, locally generate, or approximate a login QR code. If the user asks for a QR code, you must obtain it from the real page and return a screenshot of that real page.
- Before saying "你来扫码" or equivalent, call `browser_screenshot` so the chat contains the current real login page or QR code image.
- QR code screenshots are allowed and preferred. What you must not do is paste the image's raw base64, `data:image/...`, SVG source, or other long encoded payload directly into the chat body.
- Prefer element screenshots over full-page screenshots when the user specifically asks for just the QR code.
- If the user asks about a video's actual content, do not pretend a homepage card, title, or recommendation tile is the video itself. Enter the playback page first and verify that a player, subtitle area, episode page, or in-video controls are present.
- For comments, likes, follows, reposts, or other outward-facing account actions, require the user to explicitly ask for that action before doing it.

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
