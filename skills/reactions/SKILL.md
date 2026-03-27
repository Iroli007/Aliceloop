---
name: reactions
label: reactions
description: Add lightweight emoji reactions to Aliceloop session messages for acknowledgement and quick feedback; adjacent support state, not core memory.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Reactions

Use this skill for fast acknowledgement or emoji-style responses inside Aliceloop conversations.

Examples:

- mark a message as acknowledged with `👍`
- add a lightweight celebration on a finished task update
- remove a mistaken reaction from the local session log

## Workflow

1. Identify the target `sessionId` and `messageId`.
2. Add or remove reactions through the local CLI.
3. Use `reaction list` to verify the current state before claiming it changed.

```bash
aliceloop reaction list <sessionId> <messageId>
aliceloop reaction add <sessionId> <messageId> 👍
aliceloop reaction remove <sessionId> <messageId> 👍
```

## Aliceloop Status

Available for local Aliceloop sessions.

Current limits:

- reactions are stored on Aliceloop session messages, not Telegram or Discord yet
- the current implementation is API and CLI first; external channel sync is still future work
