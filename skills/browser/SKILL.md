---
name: browser
label: browser
description: Browser automation for Aliceloop. Use when the user needs to interact with websites, open a page, log in, click buttons, fill forms, take screenshots, or browse step by step.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
---

# Browser

Use CLI browser automation. Start by deciding which engine fits the task.

## Step 1: Check Chrome Relay first

Always run:

```bash
alma browser status
```

Use Chrome Relay when you need the user's real browser tabs, cookies, login state, or an already-open page.

Common commands:

```bash
alma browser tabs
alma browser read <tabId>
alma browser read-dom <tabId>
alma browser click <tabId> <cssSelector>
alma browser type <tabId> <cssSelector> "text" --enter
alma browser screenshot [tabId]
alma browser goto <tabId> <url>
alma browser open [url]
alma browser scroll <tabId> <up|down> [amount]
alma browser back <tabId>
alma browser forward <tabId>
```

## Step 2: If Relay is unavailable or you need fresh automation, use PinchTab

Ensure PinchTab exists:

```bash
which pinchtab || curl -fsSL https://pinchtab.com/install.sh | bash
```

Typical flow:

```bash
pinchtab nav https://example.com
pinchtab snap -i -c
pinchtab click e5
pinchtab fill e3 "user@example.com"
pinchtab press e7 Enter
pinchtab snap -i
```

Useful commands:

```bash
pinchtab nav <url>
pinchtab nav <url> --new
pinchtab snap -i
pinchtab snap -i -c
pinchtab text
pinchtab click e1
pinchtab fill e2 "text"
pinchtab type e2 "text"
pinchtab press e1 Enter
pinchtab screenshot
pinchtab screenshot --full
pinchtab eval 'document.title'
```

Refs from `pinchtab snap` become stale after the page changes. Re-run `pinchtab snap -i` after navigation, submission, or dynamic UI changes.

## Decision rule

- Need existing login, cookies, or the user's open tab -> Chrome Relay
- Need a fresh page, scraping, or stealth-style automation -> PinchTab
- Need a quick answer from a public page and not browser interaction -> prefer `web-search` / `web-fetch`, not this skill
