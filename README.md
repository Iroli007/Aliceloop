# Aliceloop

Aliceloop is a desktop-first local coding and computer-use agent runtime.

The current stack is:

- `apps/desktop`: Electron + React shell
- `apps/daemon`: Fastify daemon with the built-in multi-step agent runtime
- `packages/runtime-core`: shared domain types, previews, and event contracts
- `packages/pdf-ingest`: local document ingest pipeline
- `apps/daemon/src/context/skills/`: project-level `SKILL.md` catalog loaded into daemon context

## Runtime Shape

User messages enter the daemon, the daemon loads context from `apps/daemon/src/context/`, runs the built-in agent loop from `apps/daemon/src/runtime/`, executes sandbox and managed task tools, persists everything into SQLite, and pushes updates back to the desktop over snapshot + SSE.

The built-in agent currently uses:

- four core sandbox tools: `read`, `write`, `edit`, `bash`
- context skills discovered from `apps/daemon/src/context/skills/*/SKILL.md`
- managed task tools for document ingest, review coaching, and runtime scripts
- multi-step tool calling via Vercel AI SDK
- per-session serialized execution
- persisted session events, jobs, memories, artifacts, and sandbox runs
- provider configs for `MiniMax`, `OpenAI`, `Anthropic`, and `OpenRouter`

## Current Direction

Aliceloop owns the host runtime:

- session storage
- event model
- sandbox
- desktop UX
- skills, tools, and artifacts

Providers only supply reasoning. Future external engines such as Claude Code, Codex, and Gemini CLI should be integrated as adapter-backed engines or ACP-compatible peers, not as owners of the runtime.

## Commands

```bash
npm run dev:daemon
npm run dev:desktop
npm run typecheck
npm run build
```

Useful daemon smoke checks:

```bash
npm run smoke:tasks --workspace @aliceloop/daemon
npm run smoke:tasks:api --workspace @aliceloop/daemon
```
