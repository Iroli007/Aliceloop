---
name: discord
label: discord
description: Interact with Discord channels, messages, and attachments through a future Discord bridge.
description: Send Discord webhook messages and attachments from the Aliceloop CLI.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Discord

Use this skill when the task depends on Discord-specific messaging or channel actions.

## Commands

```bash
aliceloop discord send "deploy finished" --webhook <url>
aliceloop discord file ./artifact.zip "Nightly artifact" --webhook <url>
```

You can also set `ALICELOOP_DISCORD_WEBHOOK_URL` instead of passing `--webhook`.

Current scope:

- webhook posting only
- supports plain text messages and single-file uploads
- does not yet expose channel reads, thread listing, or bot-token flows
