---
name: video-analysis
description: Understand common web video playback through media probing, short audio sampling, subtitle reading, and rolling summaries. Use when the user wants to know what a web video is saying or showing.
allowed-tools:
  - browser_media_probe
  - browser_video_watch_start
  - browser_video_watch_poll
  - browser_video_watch_stop
---

# Video Analysis

Use this skill when the user wants you to actually understand a video on a website, not just stare at the homepage card or title.

Examples:

- summarize what a video is talking about
- answer "这段视频后面讲了什么"
- keep watching and report the next section
- explain what is on screen in the current playback segment

## Intended workflow

1. First make sure you are on the real playback/detail page rather than the homepage, feed, or search results.
2. Call `browser_media_probe` to confirm that the page has a visible `video` or `audio` element and to get the best player ref.
3. Start a reusable watch session with `browser_video_watch_start`.
4. On follow-up turns like “继续看” or “再听听这一段”, prefer reusing the existing watch session instead of starting over.
5. Poll the session with `browser_video_watch_poll` whenever you need fresh evidence. If there is only one active watch in the conversation, you can omit `watchId`.
6. Stop the session with `browser_video_watch_stop` when you have enough evidence for the current answer. If there is only one active watch in the conversation, you can omit `watchId`.

## Guardrails

- Do not treat a feed card, poster frame, or recommendation tile as the video itself.
- Do not pretend to hear audio when the tool says the page is paused, DRM-protected, or capture is unavailable.
- Do not claim more visual detail than the sampled screenshot evidence supports.
- If the current mode is subtitle-only or visual-only, say that explicitly.

## Aliceloop status

This skill is active.

Available tools:

- `browser_media_probe`
- `browser_video_watch_start`
- `browser_video_watch_poll`
- `browser_video_watch_stop`

Current limitations:

- this is Desktop-first for live web video; it is optimized for Aliceloop Desktop browser sessions
- it does not download the whole video, so understanding is based on incremental subtitle, audio-sample, and screenshot evidence
- OCR is intentionally excluded from this workflow
