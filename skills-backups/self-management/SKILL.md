---
name: self-management
description: Read and update Aliceloop's own settings via the `aliceloop` CLI. MUST USE when users ask to inspect or change models, providers, sandbox settings, reasoning settings, user profile fields, or other Aliceloop configuration. Always read the current config first instead of guessing paths.
allowed-tools:
  - bash
---

# Self-Management Skill

You can manage your own settings using the `aliceloop` CLI.

## Golden Rules

1. **Before changing any setting, always run `aliceloop config list` first.** Read the current config and real paths before you change anything.
2. **Do not invent old config paths.** Aliceloop currently exposes `runtime.*`, `user.*`, and `providers.<id>.*` through `config get/set`.
3. **Treat runtime and provider changes as high-impact.** They affect future turns, tool behavior, and model selection, so confirm the target value and avoid guessing.

## Commands

```bash
aliceloop status
aliceloop config list
aliceloop config get <path>
aliceloop config set <path> <value>
aliceloop providers
```

## Config Surface

### Runtime Settings

Use `runtime.*` paths for Aliceloop's own runtime behavior:

- `runtime.sandboxProfile`
- `runtime.autoApproveToolRequests`
- `runtime.reasoningEffort`
- `runtime.toolProviderId`
- `runtime.toolModel`

Examples:

```bash
aliceloop config get runtime.sandboxProfile
aliceloop config set runtime.sandboxProfile development
aliceloop config set runtime.reasoningEffort high
aliceloop config set runtime.toolProviderId minimax
aliceloop config set runtime.toolModel "MiniMax-M2.7-highspeed"
```

### User Profile

Use `user.*` paths for the owner's profile injected into prompt context:

- `user.displayName`
- `user.preferredLanguage`
- `user.timezone`
- `user.codeStyle`
- `user.notes`

Examples:

```bash
aliceloop config get user.timezone
aliceloop config set user.displayName "Raper"
aliceloop config set user.preferredLanguage "Chinese"
aliceloop config set user.codeStyle "concise"
```

### Provider Config

Use `providers.<id>.*` for saved provider settings:

- `providers.<id>.enabled`
- `providers.<id>.transport`
- `providers.<id>.baseUrl`
- `providers.<id>.model`
- `providers.<id>.apiKey`

Examples:

```bash
aliceloop providers
aliceloop config get providers.openai
aliceloop config set providers.openai.enabled true
aliceloop config set providers.openai.baseUrl "https://api.openai.com/v1"
aliceloop config set providers.openai.model "gpt-4.1"
```

## Tips

- Always read current values before writing new ones.
- Use `aliceloop providers` before provider changes so you do not guess provider IDs.
- Provider changes go through Aliceloop's saved config, not ad hoc environment variables.
- `aliceloop status` tells you whether the daemon is up; `config list` tells you what is actually configured.
- One-off macOS speech commands live under `aliceloop voice ...`; they are not the same thing as persistent self-configuration.
