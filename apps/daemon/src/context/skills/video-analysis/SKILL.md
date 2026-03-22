---
name: video-analysis
label: video-analysis
description: Analyze video files through metadata, frame sampling, and audio transcription. Use when a user shares a video and wants a summary, scene breakdown, or transcript.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
---

# Video Analysis

Use this skill when a task depends on what appears in a video, what is said, or how the visual sequence changes over time.

Examples:

- summarize a short clip or social post
- transcribe spoken content from a recording
- inspect scene changes, overlays, or visible objects
- build a contact sheet for quick review

## Workflow

1. Inspect the container and streams with `ffprobe`.
2. Extract evenly spaced frames or a thumbnail grid with `ffmpeg`.
3. Extract audio and run `whisper` when spoken content matters.
4. Combine visual evidence and transcript into a concise report, noting uncertainty where needed.
5. If the active environment exposes a direct multimodal video model, you may use it as an extra signal, but keep the file-based fallback available.

## Commands

```bash
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of json "$VIDEO_PATH"

# Extract up to 12 evenly spaced frames
OUTDIR=/tmp/aliceloop-video-$(date +%s)
mkdir -p "$OUTDIR"
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_PATH" | cut -d. -f1)
FPS_RATE=$(echo "scale=2; 12 / $DURATION" | bc 2>/dev/null || echo "1")
if (( $(echo "$FPS_RATE > 1" | bc -l 2>/dev/null || echo 0) )); then FPS_RATE=1; fi
ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" -vf "fps=$FPS_RATE,scale=720:-1" -frames:v 12 "$OUTDIR/frame_%02d.jpg"

ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" \
  -vf "fps=1/$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_PATH" | awk '{printf "%.1f", $1/9}'),scale=320:-1,tile=3x3" \
  -frames:v 1 "$OUTDIR/grid.jpg"

ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" -vn -acodec pcm_s16le -ar 16000 -ac 1 "/tmp/aliceloop-video-audio.wav"
whisper "/tmp/aliceloop-video-audio.wav" --model turbo --output_format txt --output_dir /tmp/aliceloop-video-whisper
cat /tmp/aliceloop-video-whisper/*.txt
rm -rf "$OUTDIR" /tmp/aliceloop-video-whisper /tmp/aliceloop-video-audio.wav
```

## Reporting Guide

- Distinguish direct observations from guesses.
- Mention whether the summary comes from sampled frames, full transcription, or both.
- If the clip is long, say which segment or sampling strategy you used.
- Do not imply motion details that were not visible in the extracted evidence.
