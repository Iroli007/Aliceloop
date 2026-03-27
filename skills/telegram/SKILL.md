---
name: telegram
label: telegram
description: Interact with Telegram chats, files, and bots through the Telegram Bot API from the Aliceloop CLI.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Telegram

Use this skill when the work depends on Telegram messaging, files, or bot actions.

## Commands

```bash
aliceloop telegram me --token <botToken>
aliceloop telegram send <chatId> "hello from Aliceloop" --token <botToken>
aliceloop telegram file <chatId> ./report.pdf "Daily report" --token <botToken>
```

You can also set:

- `ALICELOOP_TELEGRAM_BOT_TOKEN`
- `ALICELOOP_TELEGRAM_API_BASE` for a self-hosted proxy or testing

Current scope:

- `me`, `send`, and `file` are wired
- this uses the Bot API directly; it does not sync chat history into daemon sessions
