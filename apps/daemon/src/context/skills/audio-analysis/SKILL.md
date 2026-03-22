---
name: audio-analysis
label: audio-analysis
description: Analyze audio files for metadata, structure, transcription, and signal characteristics. Use when users share music, voice notes, or other audio and want an objective report.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
---

# Audio Analysis

Use this skill when the user wants a factual read on an audio file rather than a casual reaction.

Examples:

- summarize a song, podcast clip, or voice note
- inspect codec, duration, bitrate, and embedded tags
- transcribe spoken words or recover partial lyrics
- generate a spectrogram or other artifact for follow-up inspection

## Workflow

1. Inspect the file with `ffprobe` for container, stream, duration, bitrate, sample rate, and metadata tags.
2. Convert or trim the audio with `ffmpeg` when the source format is awkward or very long.
3. Run `whisper` when speech or lyrics matter.
4. Generate a spectrogram when frequency balance, noise, clipping, or texture matters.
5. Return an objective report with caveats instead of personal taste unless the user explicitly asks for an opinion.

## Commands

```bash
ffprobe -v quiet -print_format json -show_format -show_streams "<audio_file>"

ffmpeg -i "<audio_file>" -lavfi showspectrumpic=s=800x200:mode=combined:color=intensity -frames:v 1 "/tmp/music_spec_<id>.png" -y

ffmpeg -i "<audio_file>" -acodec pcm_s16le -ar 16000 -ac 1 "/tmp/music_audio.wav" -y
whisper "/tmp/music_audio.wav" --model turbo --output_format txt --output_dir /tmp/music_whisper
cat /tmp/music_whisper/*.txt
rm -rf /tmp/music_whisper /tmp/music_audio.wav
```

## Reporting Guide

- Separate facts from inference.
- Mention if the transcript is partial or uncertain, especially for sung vocals or noisy audio.
- Call out clipping, silence, mono vs stereo, unusual loudness, or obvious compression artifacts when relevant.
- For long files, sample a representative segment before claiming file-wide conclusions.

## Aliceloop Status

This skill relies on local command-line tools such as `ffprobe`, `ffmpeg`, and `whisper` when they are installed in the runtime environment.
