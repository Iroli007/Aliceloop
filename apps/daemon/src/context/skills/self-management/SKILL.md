---
name: self-management
label: self-management
description: Inspect and update Aliceloop runtime settings, user profile fields, and provider configs.
status: available
mode: instructional
allowed-tools:
  - bash
---

# Self Management

Use this skill when the user wants Aliceloop itself to change configuration or report its current state.

## Commands

```bash
aliceloop status
aliceloop config list
aliceloop config get runtime.sandboxProfile
aliceloop config set runtime.sandboxProfile development
aliceloop config set user.displayName "Alice"
aliceloop config set providers.openai.model "gpt-4.1"
aliceloop config set providers.openai.enabled true
aliceloop config set providers.openai.apiKey "sk-..."
aliceloop providers
```

## Tips

- Read the current value before changing high-impact settings.
- Treat `runtime.sandboxProfile` changes as important because they affect execution safety.
- Provider changes go through Aliceloop's saved provider config, not ad hoc env vars.
