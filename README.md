# Aliceloop

Aliceloop is a desktop-first local coding and computer-use agent runtime.

## Download

The current packaged macOS release is available on GitHub Releases:

- [Aliceloop v1.0.0](https://github.com/Iroli007/Aliceloop/releases/tag/v1.0.0)

Release assets currently include:

- `Aliceloop-1.0.0-arm64.dmg`: macOS installer for Apple Silicon
- `Aliceloop-1.0.0-arm64-mac.zip`: zipped macOS app bundle
- `Aliceloop-chrome-relay-extension-1.0.0.zip`: Chrome relay extension

## What It Includes

- `apps/desktop`: Electron + React desktop shell
- `apps/daemon`: Fastify daemon and built-in multi-step runtime
- `packages/runtime-core`: shared domain types, previews, and event contracts
- `packages/pdf-ingest`: local document ingest pipeline
- `skills/`: project-level `SKILL.md` catalog loaded into the runtime
- `chrome-extension/`: Chrome relay extension source

## Architecture

Aliceloop is split into a few clear layers:

1. **Desktop shell**
   `apps/desktop` owns the Electron main process, the renderer UI, the settings window, local file/folder pickers, and packaged-app bootstrap. In packaged mode it starts the bundled daemon automatically instead of depending on an external local service.
2. **Local daemon**
   `apps/daemon` is the host runtime. It owns the API surface, SQLite persistence, session/event state, task execution, sandbox policy, provider gateway, skill routing, and the multi-step agent loop.
3. **Stable contracts**
   `packages/runtime-core` defines the shared domain model between desktop and daemon: sessions, events, projects, memories, tasks, artifacts, providers, sandbox runs, runtime catalog snapshots, and more.
4. **Capability packs**
   `skills/`, `apps/daemon/runtime-scripts/`, `packages/pdf-ingest`, and `chrome-extension/` extend what the runtime can do without changing the desktop/daemon boundary.

The design goal is that the desktop is a local client, the daemon is the source of truth, and providers only supply reasoning.

## Runtime Shape

User messages enter the daemon, the daemon loads context from `apps/daemon/src/context/`, runs the built-in agent loop from `apps/daemon/src/runtime/`, executes sandbox and managed task tools, persists everything into SQLite, and pushes updates back to the desktop over snapshot + SSE.

The built-in runtime currently uses:

- six atomic commands: `read`, `grep`, `glob`, `write`, `edit`, `bash`
- context skills discovered from `skills/*/SKILL.md`
- ephemeral helper files or scripts synthesized with `write` / `edit` and executed with `bash`
- managed task tools for document ingest, review coaching, and runtime scripts
- multi-step tool calling via Vercel AI SDK
- per-session serialized execution
- persisted session events, jobs, memories, artifacts, and sandbox runs
- provider configs for `MiniMax`, `OpenAI`, `Anthropic`, and `OpenRouter`

## Runtime Flow

1. The desktop renderer sends user actions to the daemon over local HTTP.
2. The daemon builds context from persona prompts, recent conversation, project binding, memory, routed skills, and tool availability.
3. The runtime chooses from a bounded tool surface. Skills are instruction text and routing metadata, not executable endpoints by themselves.
4. Tool calls, approvals, artifacts, messages, tasks, memories, and presence updates are persisted in SQLite and emitted back to the desktop through snapshot + SSE.
5. The desktop updates thread state in real time and exposes settings, runtime catalog, projects, providers, and browser relay controls.

One important architectural choice is that Aliceloop keeps the tool ABI intentionally small. The model can synthesize disposable helper files through `write` / `edit` and execute them with `bash`, but it does not dynamically register new first-class tools at runtime.

## Packaged App Layout

The packaged desktop app is self-contained:

- the Electron app boots the bundled daemon on `127.0.0.1:3030`
- the Chrome relay bridge uses `23001`
- private runtime state stays inside the app `userData` area
- public user-facing runtime assets are materialized to `~/aliceloop/`

The public directory is intentionally small and user-browsable:

- `~/aliceloop/chrome-extension`
- `~/aliceloop/skills`
- `~/aliceloop/scripts`
- `~/aliceloop/workspace`

This keeps the distributed app closed and portable while still giving users a stable place to load the Chrome extension, inspect public skills/scripts, and open project/workspace paths from inside the app.

## Local Development

```bash
npm install
npm run dev:daemon
npm run dev:desktop
```

Useful checks:

```bash
npm run typecheck
npm run build
npm run smoke:tasks --workspace @aliceloop/daemon
npm run smoke:tasks:api --workspace @aliceloop/daemon
```

To build the packaged desktop app:

```bash
npm run package:dmg --workspace @aliceloop/desktop
```
