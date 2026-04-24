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

- six atomic commands: `read`, `grep`, `glob`, `write`, `edit`, `bash`
- context skills discovered from `apps/daemon/src/context/skills/*/SKILL.md`
- ephemeral helper files or scripts synthesized with `write` / `edit` and executed with `bash`
- managed task tools for document ingest, review coaching, and runtime scripts
- multi-step tool calling via Vercel AI SDK
- per-session serialized execution
- persisted session events, jobs, memories, artifacts, and sandbox runs
- provider configs for `MiniMax`, `OpenAI`, `Anthropic`, and `OpenRouter`

Those helper files are disposable implementation details. They do not register new tools or expand the built-in agent ABI.

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

## Test Commands

```bash
npm run smoke
npm run test:integration
npm run test:e2e
npm test
```

Daemon smoke is the fast main-path check: health, session creation, message persistence, local fallback assistant reply, and runtime catalog projection. Domain coverage lives under integration scripts:

```bash
npm run integration:skills --workspace @aliceloop/daemon
npm run integration:api --workspace @aliceloop/daemon
npm run integration:sandbox --workspace @aliceloop/daemon
npm run smoke:desktop-ui
```

Local browser backend checks are kept as opt-in integration scripts because they depend on a working desktop browser/relay environment:

```bash
npm run integration:chrome-relay --workspace @aliceloop/daemon
npm run integration:desktop-relay --workspace @aliceloop/daemon
npm run integration:pinchtab-browser --workspace @aliceloop/daemon
```
