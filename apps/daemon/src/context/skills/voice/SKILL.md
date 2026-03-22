---
name: voice
label: voice
description: Synthesize speech and export spoken audio on macOS through the local `say` TTS engine.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Voice

Use this skill when the user wants text turned into spoken audio on the local Mac.

Examples:

- read a short reply aloud
- export a spoken memo to an audio file
- inspect installed system voices before choosing one

## Workflow

1. List available voices if the user cares about accent or tone.
2. Use `aliceloop voice speak` for ephemeral playback.
3. Use `aliceloop voice save` when the user needs a reusable audio artifact.
4. Keep the output path explicit so the audio file can be reused or attached later.

```bash
aliceloop voice list
aliceloop voice speak "今天的任务已经排好了。"
aliceloop voice save /tmp/aliceloop-reply.aiff "这是一段导出的语音。" --voice Ting-Ting --rate 190
```

## Aliceloop Status

Available on macOS through the built-in `/usr/bin/say` engine.

Current limits:

- macOS only
- output format follows what `say -o` supports locally
- this is local TTS, not voice cloning or cloud speech generation
