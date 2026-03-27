---
name: send-file
label: send-file
description: Send local files or photos into an Aliceloop conversation from the CLI.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Send File

Use this skill when the user wants Aliceloop to push a file somewhere instead of only creating it locally.

## Commands

```bash
aliceloop send file ./report.pdf "Please review this"
aliceloop send photo ./screenshot.jpg "Current UI state"
aliceloop send file ./notes.txt --session SESSION_ID
```

## Tips

- If no `--session` is provided, the CLI uses `ALICELOOP_SESSION_ID` or the latest active thread.
- `send photo` only changes MIME handling; it still uploads through the same attachment pipeline.
- This currently targets Aliceloop conversations, not external chat platforms.
