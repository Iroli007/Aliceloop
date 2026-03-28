---
name: image-gen
description: Generate images from prompts through an OpenAI-compatible image backend and save them locally.
allowed-tools:
  - bash
  - read
---

# Image Gen

Use this skill when the user wants a new AI-generated image rather than image analysis.

Examples:

- generate a concept art variation into a local file
- try a different image model or provider without changing the whole runtime
- save the generated image first, then attach it into a session with `send-file`

## Workflow

1. Pick an enabled OpenAI-compatible provider, or pass one explicitly.
2. Generate the image into a concrete output path.
3. Inspect the returned file metadata and revised prompt before claiming success.

```bash
aliceloop image generate "a quiet book-filled studio at sunrise" --provider openai
aliceloop image generate "retro CLI mascot sticker sheet" --provider openrouter --output /tmp/aliceloop-stickers.png
```

## Aliceloop Status

Available through `/api/images/generate` and `aliceloop image generate`.

Current limits:

- requires an enabled OpenAI-compatible provider or an explicit `--provider`
- the current backend path targets `/images/generations`
- only single-image generation is wired right now
