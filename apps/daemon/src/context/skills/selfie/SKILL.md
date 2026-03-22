---
name: selfie
label: selfie
description: Planned Alice-native selfie workflow for self-portraits, local album management, and future face-reference generation support.
status: planned
mode: instructional
allowed-tools:
  - bash
  - read
  - write
  - glob
---

# Selfie

Use this skill when the user wants selfies or self-portraits that should stay visually consistent over time.

## Current Status

This skill is a catalog target, not an active runtime capability yet.

Today Aliceloop can:

- generate prompt-only images with `aliceloop image generate`
- store generated files locally
- send finished images back into a thread

What is still missing for a full selfie workflow:

- reference-image conditioning in `/api/images/generate`
- a stable album metadata format for appearance tracking
- a repeatable face-consistency path across sessions

## Intended Album Layout

Store selfie assets under:

```text
~/.aliceloop/selfies/
```

Recommended structure:

```text
~/.aliceloop/selfies/
  profile.json
  references/
  generated/
```

## Intended Workflow

1. Create or inspect the local selfie album.
2. Keep a short appearance profile in `profile.json` with stable traits, style cues, and preferred camera framing.
3. Save the strongest reference images into `references/`.
4. Generate new selfie-style outputs into `generated/`.
5. Once the image backend supports reference inputs, pass the saved references into the generation step for consistency.

## Temporary Best-Effort Fallback

Until face-reference support exists, use prompt-only generation and be explicit that identity consistency is approximate:

```bash
mkdir -p ~/.aliceloop/selfies/generated
aliceloop image generate "natural handheld phone selfie, soft window light, same subject as prior Alice profile, candid expression" \
  --output ~/.aliceloop/selfies/generated/selfie-$(date +%Y%m%d-%H%M%S).png
```

## Album Management

Useful local commands:

```bash
mkdir -p ~/.aliceloop/selfies/references ~/.aliceloop/selfies/generated
find ~/.aliceloop/selfies -type f | sort
ls -lt ~/.aliceloop/selfies/generated | head
```

## Guardrails

- Do not claim strong face consistency until the backend can actually use reference images.
- Keep album paths local to Aliceloop rather than older Alma-specific locations.
- Treat stored reference photos as private user assets.
