---
name: twitter-media
label: twitter-media
description: Extract text and media from Twitter/X post URLs through the fxtwitter-compatible API. Use when users share a twitter.com or x.com link and want the post contents or media assets.
status: available
mode: instructional
allowed-tools:
  - bash
  - web_fetch
---

# Twitter Media Skill

Use this skill to turn a Twitter/X post URL into structured text, image links, video links, and local downloads when needed.

Examples:

- summarize a linked tweet
- inspect the attached images or video thumbnails
- save the raw media locally for a later step
- extract the post text without opening the main site

## API

Twitter/X blocks most direct scraping, so use the public fxtwitter-compatible JSON endpoint:

```text
https://api.fxtwitter.com/{username}/status/{tweet_id}
```

If fxtwitter is unavailable, try `https://api.vxtwitter.com/{username}/status/{tweet_id}`.

## Workflow

1. Parse the username and tweet id from the shared URL.
2. Fetch the JSON payload from the API.
3. Return the tweet text, author, and media list.
4. Download specific media files only when the user needs them for follow-up analysis or reuse.

## URL Parsing

```bash
URL="https://x.com/YRyokan51928/status/2026565956206817573?s=20"
CLEAN=$(echo "$URL" | sed 's/[?#].*//' | sed 's:/*$::')
USERNAME=$(echo "$CLEAN" | grep -oP '(?:twitter\.com|x\.com)/\K[^/]+')
TWEET_ID=$(echo "$CLEAN" | grep -oP 'status/\K[0-9]+')
```

## Fetch and Extract

```bash
curl -s "https://api.fxtwitter.com/${USERNAME}/status/${TWEET_ID}" | python3 -m json.tool

curl -s "https://api.fxtwitter.com/${USERNAME}/status/${TWEET_ID}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tweet = data.get('tweet', {})
print('Author:', tweet.get('author', {}).get('name', 'unknown'))
print('Text:', tweet.get('text', '(no text)'))
media = tweet.get('media', {})
for item in media.get('all', []):
    mtype = item.get('type', 'unknown')
    if mtype == 'photo':
        print(f'Photo: {item[\"url\"]}')
    elif mtype == 'video':
        print(f'Video: {item[\"url\"]}')
        print(f'Thumbnail: {item[\"thumbnail_url\"]}')
    elif mtype == 'gif':
        print(f'GIF: {item[\"url\"]}')
        print(f'Thumbnail: {item[\"thumbnail_url\"]}')
"
```

## Download Media

```bash
curl -sL -o /tmp/tweet_photo.jpg "PHOTO_URL"
curl -sL -o /tmp/tweet_thumb.jpg "THUMBNAIL_URL"
curl -sL -o /tmp/tweet_video.mp4 "VIDEO_URL"
```

## Tips

- The API is public and typically requires no authentication.
- For videos, prefer the highest-bitrate MP4 variant when several formats are available.
- Thumbnails are often enough for a quick visual summary when full video download is unnecessary.
- Save downloads to explicit local paths so later steps can reuse them or attach them through a separate file-sharing workflow.
