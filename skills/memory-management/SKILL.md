---
name: memory-management
label: memory-management
description: Search and manage Aliceloop profile/fact memory. Use when the user asks about remembered preferences, long-term facts, account details, explicit remember/forget actions, or continuity-sensitive personal facts.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Memory Management Skill

Use this skill for Aliceloop's Profile / Fact Memory layer.

This layer is for stable information:
- user preferences
- long-term personal facts
- account-level facts
- persistent constraints
- durable decisions

Do not use this skill for raw conversation replay. If the user is asking "what did we say before", "what did I tell you yesterday", or wants the original thread context, route or combine with `thread-management`.

## Tools

```bash
aliceloop memory list [limit]
aliceloop memory search "<query>"
aliceloop memory add "<content>"
aliceloop memory delete <id>
```

## When to Use

- **User asks about remembered personal facts**:
  - "do you remember what I like"
  - "what are my preferences"
  - "you know my style right"
- **User explicitly asks to remember something**:
  - "remember this"
  - "记住我以后喜欢简洁回答"
  - "以后都按这个来"
- **User asks to forget or overwrite a stable fact**:
  - "forget that"
  - "我现在不喜欢 A 了"
  - "把以前那个偏好删掉"
- **You need stable profile/fact memory before answering a continuity-sensitive question**

## Search Strategy

When the user asks about remembered information, use this order:

1. `aliceloop memory search "<query>"` first
2. answer from matching active facts if results are clear
3. if the question is really about prior conversation wording or chronology, also use `thread-management`

Use Profile / Fact Memory for **facts**.
Use Episodic History for **what was said in a conversation**.

## Commands

```bash
# List stored memories
aliceloop memory list

# Search remembered facts/preferences
aliceloop memory search "<query>"

# Add a stable memory
aliceloop memory add "<content>"

# Delete a memory by id
aliceloop memory delete <id>
```

## Add Strategy

Before adding a new fact:

1. search for related memory first
2. avoid adding near-duplicates
3. prefer one concise stable statement over a long paragraph
4. set `factKind` whenever the type is obvious

Recommended `factKind` values:
- `preference` for likes/dislikes/style preferences
- `constraint` for hard requirements or "never do X"
- `decision` for settled choices
- `profile` for durable personal facts
- `account` for account/tool/provider information
- `workflow` for stable ways the user wants work done
- `other` if nothing else fits

Use `factKey` when the fact belongs to a stable slot that may later be replaced.
Examples:
- `response_style`
- `language_preference`
- `favorite_editor`
- `timezone_preference`

This helps newer facts supersede older ones cleanly.

## Delete Strategy

When the user asks to forget something:

1. search first
2. identify the exact matching memory
3. run `aliceloop memory delete <id>` on the correct memory id
4. confirm what was removed

Do not guess memory ids.

## Pairing With Other Memory Skills

- Use `thread-management` when the user wants past thread content, wording, or chronology.
- Use `self-reflection` for rolling session-level conclusions and temporary discussion summary.
- Use this skill only for durable profile/fact memory.

## Tips

- Always confirm what you stored or deleted.
- Prefer stable facts over noisy transcript-like text.
- Do not claim a memory exists unless `aliceloop memory search` actually found it.
- If a user says a previous preference changed, treat the new fact as the current truth and update memory accordingly.
