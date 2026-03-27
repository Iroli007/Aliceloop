---
name: music-gen
label: music-gen
description: Generate short prompt-driven MIDI music sketches locally from the Aliceloop CLI.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Music Gen

Use this skill when the request is for generated musical ideas, not ordinary audio playback or editing.

## Commands

```bash
aliceloop music generate "calm piano sunrise" --output /tmp/sunrise.mid
aliceloop music generate "retro 8-bit chase theme" --tempo 140 --bars 8
```

Current scope:

- outputs a `.mid` sketch file, not rendered audio
- prompt keywords steer tempo, scale, and instrument family
- useful for quick composition seeds and downstream DAW import
