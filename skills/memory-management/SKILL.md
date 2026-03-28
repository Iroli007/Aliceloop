---
name: memory-management
label: memory-management
description: Search and manage Aliceloop's memory and conversation recall. Use when the user asks about past conversations, personal facts, preferences, or anything that requires recalling information ("do you know my...", "we talked about before...", "do you remember...", "help me find what we said about..."). Also used to store new durable memories and search through archived chat threads.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Memory Management Skill

Aliceloop has a built-in recall system with two layers:
- durable memory for stable facts and preferences
- conversation history search for past thread wording

Use the `aliceloop` CLI to interact with it.

## Tools

```bash
# List memories
aliceloop memory list [limit]

# Semantic search
aliceloop memory search "<query>"

# Search conversation history
aliceloop memory grep "<query>"

# Force transcript archive resync
aliceloop memory archive

# Add a memory
aliceloop memory add "<content>"

# Delete a memory
aliceloop memory delete <id>
```

## When to Use

- **User asks anything about the past** ("do you know what I like", "what did we discuss before", "what was that plan we talked about last time") → Search memory AND grep threads
- **User says "remember this"** → `aliceloop memory add "..."`
- **User asks "do you remember..."** → `aliceloop memory search "..."` + `aliceloop memory grep "..."`
- **User says "forget about..."** → Search and delete matching memories
- **Time-sensitive info** (projects, deadlines) → Store with appropriate context

## Search Strategy

When the user asks about past information, always try both layers when needed:

1. `aliceloop memory search "<query>"` for semantic recall of stable facts
2. `aliceloop memory grep "<keyword>"` for keyword search in conversation history

If one layer is not enough, use the other. They complement each other.

## Two-Layer Recall

1. **Vector Memory** (`aliceloop memory search`) — semantic search, finds conceptually related memories
2. **Conversation History** (`aliceloop memory grep`) — keyword search, finds exact words and phrases in past threads

Use semantic search when the user asks vague recall questions.
Use grep when you need specific terms, names, wording, or code snippets.

## Conversation History Search

Aliceloop automatically exports project-backed thread transcripts as markdown files. `memory grep` prioritizes those conversation archives in `threads/` before falling back to live runtime history.

```bash
# Keyword search through archived conversations
aliceloop memory grep <keyword>

# Force re-export of thread archives now
aliceloop memory archive
```

Conversation archives are stored in the project's `threads/` directory as markdown files with frontmatter (`threadId`, `title`, `createdAt`, `updatedAt`, `model`, `messageCount`). They are auto-exported when sessions change and can be resynced explicitly with `memory archive`.

## Durable Memory

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

Prefer one concise stable statement over a long transcript-like paragraph.
If a stable preference changed, treat the new fact as the current truth.

## Pairing With Other Skills

- Use `thread-management` when the user wants to inspect, create, list, or delete threads directly.
- Use `thread-management` after recall search when you need exact thread context from a specific candidate.
- Use `self-reflection` for rolling session-level conclusions and temporary discussion summary.

## Tips

- Always confirm what you stored or deleted.
- Do not claim a memory exists unless retrieval actually found it.
- Use `aliceloop memory grep` when vector recall does not give enough exact evidence.
- Durable memory should stay concise and stable rather than transcript-like.
