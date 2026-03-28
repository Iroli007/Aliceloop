---
name: twitter-media
label: twitter-media
description: Extract content from Twitter/X links, x.com links, twitter.com links, and tweet URLs, or use OpenCLI for logged-in Twitter/X actions such as search, profile reads, timeline reads, bookmarks, notifications, and lightweight interactions.
status: available
mode: instructional
source-url: https://github.com/jackwener/opencli
allowed-tools:
  - bash
  - web_fetch
---

# Twitter Media

Use this skill for Twitter/X-specific tasks. Prefer the smallest path that fits.

## Public Links

For a public `twitter.com` or `x.com` status link where the user only wants the post text, author, media, or thumbnail, prefer the free fxtwitter-compatible API.

It does not require login and is usually the fastest path.

```bash
URL="https://x.com/username/status/123456789?s=20"
CLEAN=$(echo "$URL" | sed 's/[?#].*//' | sed 's:/*$::')
USERNAME=$(echo "$CLEAN" | grep -oE '(twitter\.com|x\.com)/[^/]+' | sed 's#^.*/##')
TWEET_ID=$(echo "$CLEAN" | grep -oE 'status/[0-9]+' | sed 's#status/##')
curl -s "https://api.fxtwitter.com/${USERNAME}/status/${TWEET_ID}"
```

If fxtwitter is unavailable, try the compatible fallback:

```bash
curl -s "https://api.vxtwitter.com/${USERNAME}/status/${TWEET_ID}"
```

If the user needs the actual asset, you can download media directly:

```bash
curl -sL -o /tmp/tweet_photo.jpg "PHOTO_URL"
curl -sL -o /tmp/tweet_thumb.jpg "THUMBNAIL_URL"
curl -sL -o /tmp/tweet_video.mp4 "VIDEO_URL"
```

## Logged-In Twitter/X

For timeline browsing, search, bookmarks, notifications, profile inspection, or lightweight actions, use OpenCLI:

```bash
skills/browser/scripts/opencli doctor
skills/browser/scripts/opencli twitter search "openai" -f json
skills/browser/scripts/opencli twitter profile openai -f json
skills/browser/scripts/opencli twitter timeline openai -f json
skills/browser/scripts/opencli twitter bookmarks -f json
skills/browser/scripts/opencli twitter notifications -f json
```

OpenCLI fits when:

- the task needs the logged-in session
- the task is structured and Twitter-specific
- the user wants repeatable JSON output

## Constraints

- If the user needs a visible login page, QR, or captcha handoff, switch to the browser skill.
- If a simple public tweet link is enough, prefer fxtwitter over OpenCLI.
