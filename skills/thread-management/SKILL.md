---
name: thread-management
label: thread-management
description: Search and inspect Aliceloop episodic history. Use when the user asks what was said before, refers to a previous conversation, wants raw thread recall, or needs conversation chronology instead of stable facts.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Thread Management Skill

Use this skill for Aliceloop's Episodic History layer.

This layer is for raw conversation history:
- past threads
- prior conversation turns
- what was said before
- conversation chronology
- case replay and recap

Do not use this skill as a generic fact store. If the user wants stable preferences or durable profile facts, use `memory-management`.

## Tools

```bash
aliceloop threads [limit]
aliceloop thread search "<query>"
aliceloop thread info <id>
aliceloop thread new [title]
aliceloop thread delete <id>
```

## When to Use

- **User asks what was said before**:
  - "我昨天晚上跟你说啥呢来着"
  - "what did we discuss before"
  - "之前那个方案我们怎么定的"
- **User references a previous thread or past case**
- **User wants wording, chronology, or original context**
- **You need to confirm whether something was actually said, instead of relying on stable memory**

## Search Strategy

When the user asks about past conversation history:

1. use `thread_search` first to find the most likely threads
2. inspect the best match with `thread_info`
3. answer from the retrieved thread content

## Commands

```bash
# List recent threads
aliceloop threads

# Search past threads
aliceloop thread search "<query>"

# Inspect one thread
aliceloop thread info <id>
```

If thread search is ambiguous:
- check multiple candidates
- prefer the most recent relevant thread
- say when you are inferring rather than quoting directly

## How This Differs From Fact Memory

- `thread-management` answers: "what did we say?"
- `memory-management` answers: "what do I know about the user or the project?"

If a question mixes both, use both skills:
- thread history for exact recall
- fact memory for durable preferences or facts

## Tips

- Use `aliceloop thread search` before `aliceloop thread info`; do not guess thread ids.
- Treat thread history as raw evidence, not as the source of stable truth.
- If the user asks for exact prior wording, make that clear and rely on thread history.
