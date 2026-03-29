---
name: video-reader
description: Read and analyze local video files. Use when a user sends a video and asks what is happening, what was said, or wants a summary of the clip.
allowed-tools:
  - Bash
  - Read
  - view_image
---

# Video Reader Skill

## Primary Method: `aliceloop video analyze`

### MANDATORY: Use `aliceloop video analyze` for ALL local video tasks. Do not jump straight to manual `ffmpeg` steps unless the command explicitly fails.

Always use this first. It requires a configured Gemini provider and will extract representative frames, optionally transcribe speech with Whisper if available, and then synthesize an answer.

```bash
# Analyze a video
aliceloop video analyze "/path/to/video.mp4" "Describe what's happening in this video"

# Custom prompts
aliceloop video analyze "/path/to/video.mp4" "What language are they speaking? Summarize what they said"
aliceloop video analyze "/path/to/video.mp4" "Is this video funny? Why?"
aliceloop video analyze "/path/to/video.mp4" "Transcribe all spoken words in this video"
```

This command is only available when Gemini is configured in Aliceloop. If Gemini is unavailable, the command should fail clearly instead of silently falling back to another provider.

**When to use it:**

- Any video understanding task
- "What's in this video", "What did they say", "Summarize this"
- Best available local path in this repo for offline file-based video understanding

## Fallback Method: Frame Extraction + Whisper

Use this only if `aliceloop video analyze` fails and you still need to salvage something manually:

```bash
# Get video info
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of json "$VIDEO_PATH"

# Extract key frames (1 per second, max 12 frames)
OUTDIR=/tmp/aliceloop-frames-$(date +%s)
mkdir -p "$OUTDIR"
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_PATH" | cut -d. -f1)
FPS_RATE=$(echo "scale=2; 12 / $DURATION" | bc 2>/dev/null || echo "1")
if (( $(echo "$FPS_RATE > 1" | bc -l 2>/dev/null || echo 0) )); then FPS_RATE=1; fi
ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" -vf "fps=$FPS_RATE,scale=720:-1" -frames:v 12 "$OUTDIR/frame_%02d.jpg"
ls "$OUTDIR"
```

Inspect representative frames or a thumbnail grid with:

```text
view_image(path="$OUTDIR/grid.jpg")
```

### Audio Transcription (Whisper)

```bash
# Extract audio
AUDIO_PATH="/tmp/aliceloop-video-audio-$(date +%s).wav"
ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" -vn -acodec pcm_s16le -ar 16000 -ac 1 "$AUDIO_PATH"

# Transcribe
whisper "$AUDIO_PATH" --model turbo --output_format txt --output_dir /tmp/aliceloop-whisper
```

Then read the transcript:

```text
Read(targetPath="/tmp/aliceloop-whisper/<file>.txt")
```

### Thumbnail Grid (quick overview)

```bash
ffmpeg -hide_banner -loglevel error -i "$VIDEO_PATH" \
  -vf "fps=1/$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_PATH" | awk '{printf "%.1f", $1/9}'),scale=320:-1,tile=3x3" \
  -frames:v 1 "$OUTDIR/grid.jpg"
```

## Decision Flow

1. **ALWAYS**: Use `aliceloop video analyze` first.
2. **ONLY if `aliceloop video analyze` returns an error**: Fall back to manual frame extraction + Whisper.
3. **Audio only** ("what did they say"): Can use Whisper directly.
4. **Always clean up**:

```bash
rm -rf "$OUTDIR" /tmp/aliceloop-whisper "$AUDIO_PATH"
```

NEVER skip step 1. If you find yourself writing `ffmpeg` or `ffprobe` for video analysis without first trying `aliceloop video analyze`, you are doing it wrong.
