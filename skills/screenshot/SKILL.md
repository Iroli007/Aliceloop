---
name: screenshot
description: Take screenshots of the screen using macOS screencapture. Use when users ask to see the screen, debug UI, or capture what's displayed. Resize before returning to avoid blowing up model context.
allowed-tools:
  - bash
  - read
---

# Screenshot Skill

Take screenshots using macOS `screencapture` command via Bash.

## Important: Always Resize for Context

Full-resolution screenshots (especially on Retina/5K displays) produce huge base64 that will exceed the model's context length. **Always resize before reading.**

## Take and View a Screenshot

```bash
# 1. Capture full screen
screencapture -x -t jpg /tmp/aliceloop-screenshot.jpg

# 2. Resize to 1024px wide (critical for context size!)
sips --resampleWidth 1024 --setProperty formatOptions 60 /tmp/aliceloop-screenshot.jpg --out /tmp/aliceloop-screenshot-thumb.jpg

# 3. Get dimensions
sips -g pixelWidth -g pixelHeight /tmp/aliceloop-screenshot.jpg
```

Then use the Read tool to read `/tmp/aliceloop-screenshot-thumb.jpg` (the resized version, NOT the full-size one).

## Capture Options

```bash
# Full screen (default)
screencapture -x -t jpg /tmp/aliceloop-screenshot.jpg

# Interactive window selection
screencapture -x -w -t jpg /tmp/aliceloop-screenshot.jpg

# Specific region (x,y,w,h)
screencapture -x -R 0,0,800,600 -t jpg /tmp/aliceloop-screenshot.jpg

# With 3-second delay
screencapture -x -T 3 -t jpg /tmp/aliceloop-screenshot.jpg
```

## Aliceloop Bash Form

In Aliceloop, prefer the `bash` tool in `command` + `args` form for screenshot steps.

```json
{"command":"screencapture","args":["-x","-t","jpg","/tmp/aliceloop-screenshot.jpg"]}
```

```json
{"command":"sips","args":["--resampleWidth","1024","--setProperty","formatOptions","60","/tmp/aliceloop-screenshot.jpg","--out","/tmp/aliceloop-screenshot-thumb.jpg"]}
```

```json
{"command":"sips","args":["-g","pixelWidth","-g","pixelHeight","/tmp/aliceloop-screenshot.jpg"]}
```

If you use `script`, keep it simple and avoid shell redirection in development mode.

## Send Screenshot to User

If the user wants to see the screenshot directly, send the image through the current thread tooling or just describe what you see. The full-resolution file is at `/tmp/aliceloop-screenshot.jpg`.

## Tips

- **Always resize** before reading into context — use the thumb version
- `-x` flag suppresses the capture sound
- `-t jpg` outputs JPEG (smaller than PNG)
- Use `sips --setProperty formatOptions 60` for higher compression if needed
- If a command fails, check whether you accidentally put flags into `command` instead of `args`
- If a script fails immediately in development mode, remove shell redirection first
