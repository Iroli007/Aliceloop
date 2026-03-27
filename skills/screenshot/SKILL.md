---
name: screenshot
label: screenshot
description: Capture and resize screenshots on macOS for UI debugging, visual confirmation, and quick sharing.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
---

# Screenshot

Use this skill when the user needs to inspect what is on screen or verify a visual state.

## Workflow

1. Capture the screen with `screencapture`.
2. Resize the image before reading it into context.
3. Inspect the resized copy, not the full Retina original.

## Commands

```bash
/usr/sbin/screencapture -x -t jpg /tmp/aliceloop-screenshot.jpg
/usr/bin/sips --resampleWidth 1024 --setProperty formatOptions 60 /tmp/aliceloop-screenshot.jpg --out /tmp/aliceloop-screenshot-thumb.jpg 2>/dev/null
/usr/bin/sips -g pixelWidth -g pixelHeight /tmp/aliceloop-screenshot.jpg 2>/dev/null
```

## Tips

- Use `-w` for interactive window selection when a full-screen capture is too noisy.
- Resize before `read` so image context stays compact.
- Prefer JPEG for quick diagnostics unless alpha or pixel-perfect detail matters.
