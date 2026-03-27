---
name: audio-analysis
label: audio-analysis
description: Understand audio, voice notes, and spoken clips through a direct audio tool. Use when the user shares audio or asks what was said, summarized, or emphasized.
status: available
mode: instructional
allowed-tools:
  - audio_understand
---

# Audio Analysis

Use this skill when the user wants to understand what is being said in an audio file rather than just inspect file metadata.

Examples:

- transcribe a voice note or podcast clip
- summarize a spoken recording
- answer "他说了什么" / "这段音频在讲什么"
- extract key moments from a short clip
- support browser video watching by understanding sampled audio segments

## Intended workflow

1. Use `audio_understand` on the local attachment path.
2. Pass an explicit `instruction` when the user has a concrete question, such as "重点看他是怎么评价这件事的".
3. If the tool reports limitations, surface them honestly instead of pretending the audio was understood.
4. Separate direct transcript evidence from your own inference.

## Reporting guide

- Prefer factual wording over taste or vibes unless the user asks for opinion.
- If the result is partial, noisy, or unsupported by the current provider, say so clearly.
- For short clips, quote the key point in plain language.
- For long clips, summarize the main sections and list a few notable moments.

## Aliceloop status

This skill is active.

Available tools:

- `audio_understand`

Current limitations:

- audio understanding depends on the current provider stack; if the provider cannot process audio, the tool returns structured limitations instead of fake confidence
- this skill focuses on content understanding, not studio-grade waveform diagnostics
