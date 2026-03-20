# Aliceloop Project Spec v2

## 1. Product

Aliceloop is a desktop-first local coding and computer-use agent.

Core idea:

- Aliceloop owns the host runtime
- model gateways only supply reasoning
- the built-in agent loop operates through six atomic commands: `read`, `grep`, `glob`, `write`, `edit`, `bash`
- session state, events, memories, artifacts, and sandbox runs stay inside the local daemon

This is not a thin wrapper around an external agent SDK.

## 2. Monorepo

```text
apps/desktop
apps/daemon
packages/runtime-core
packages/pdf-ingest
```

Responsibilities:

- `apps/desktop`: Electron shell, session UI, model gateway settings, runtime catalogs
- `apps/daemon`: Fastify daemon, built-in agent runtime, context loading, persistence, SSE
- `packages/runtime-core`: shared types and preview contracts
- `packages/pdf-ingest`: document ingest and structure extraction
- `apps/daemon/src/context/skills/`: project-level `SKILL.md` catalog

## 3. Runtime Architecture

```text
Desktop / future clients
  -> daemon HTTP API
  -> context loader
  -> built-in agent runtime
  -> sandbox + skills
  -> SQLite persistence + session events
  -> SSE back to clients
```

The daemon remains the source of truth for:

- sessions
- jobs
- tool lifecycle events
- artifacts
- memories
- sandbox audit trail
- model gateway configs

## 4. Context Layer

Context is assembled from `apps/daemon/src/context/`.

Current modules:

- `context/prompts`: identity prompt loading
- `context/session`: recent message window
- `context/memory`: attention + note injection + lightweight distillation
- `context/tools`: sandbox tools plus managed task tools
- `context/skills`: instructional `SKILL.md` catalog loaded into runtime context
- `context/mcp`: reserved stubs for future MCP client work, used to connect user-installed MCP servers

`loadContext(sessionId, abortSignal)` returns:

- system prompt
- model messages
- tool set
- safety config

## 5. Built-In Agent Runtime

The built-in runtime lives in `apps/daemon/src/runtime/`.

Current shape:

- Vercel AI SDK based multi-step loop
- `streamText()` with tool calling
- `stepCountIs()` stop condition
- per-session serialized execution
- streaming assistant message updates
- tool lifecycle events persisted into `session_events`
- post-turn memory reflection

This replaced the old vendor-specific reply path.

## 6. Tool Model

The base capability layer is the six-command sandbox ABI:

- `sandbox_read`
- `sandbox_grep`
- `sandbox_glob`
- `sandbox_write`
- `sandbox_edit`
- `sandbox_bash`

`sandbox_bash` is intentionally allowlisted. It currently supports safe repository and local runtime commands such as:

- `rg`
- `ls`
- `cat`
- `git`
- `npm`
- `node`
- `tsx`

The model may also synthesize temporary helper files or scripts inside the sandbox, execute them through `sandbox_bash`, and discard them after use. That is an implementation pattern on top of the six-command ABI, not a first-class capability and not a tool-registration surface.

No runtime path should allow the model to register new system tools dynamically. Higher-level capabilities belong in `skills`.

Skills are no longer masquerading as runnable task entries. The `SKILL.md` catalog is injected into context for routing and behavior guidance, while executable capabilities stay in `context/tools/`.

Managed task tools currently cover:

- document ingest
- review coach
- runtime scripts

## 7. Gateway Layer

Model orchestration is unified behind Vercel AI SDK, with a centralized gateway registry.

Current implementation rules:

- supported gateway profiles are `minimax`, `aihubmix`, `openai`, `anthropic`, and `openrouter`
- `aihubmix` defaults to `transport=auto`
- `claude*` models use the Anthropic-compatible path when `transport=auto`
- all other models use the OpenAI-compatible path when `transport=auto`
- direct providers keep explicit transports in the registry
- gateway settings stay user-editable in the desktop shell

## 8. Persistence and Safety

SQLite remains the only persistence layer in v2.

Persisted entities include:

- sessions
- session messages
- session events
- job runs
- task runs
- memory notes
- `memory_notes_fts`
- artifacts
- sandbox runs

Safety rules:

- per-session serialized execution
- max iteration bound
- max duration bound
- user interruption on new message
- sandbox path and command allowlists

## 9. Implementation Status

Completed now:

- Phase 1: `context/` skeleton and loader
- Phase 2: built-in runtime and safety guard
- Phase 3: gateway/domain/schema updates
- Phase 4: daemon wiring and vendor-specific cleanup
- Phase 5: memory injection and basic reflection
- Phase 6: `SKILL.md` catalog moved into `apps/daemon/src/context/skills/`
- Phase 7: MCP marketplace catalog + installed-state flow

Still pending:

- real MCP transport wiring for user-installed servers
- external engine adapters
- browser / web skill adapters behind ACP or native tool bridges

## 10. Future Engine Adapters

The next expansion after the built-in runtime is an adapter layer, not a runtime rewrite.

Target direction:

- keep Aliceloop as the host runtime
- add ACP-compatible engine adapters
- support external engines such as Claude Code, Codex, and Gemini CLI

Those engines should plug into Aliceloop's session, sandbox, and event model instead of replacing them.

## 11. File-Level Expectations

New runtime-critical files:

```text
apps/daemon/src/context/**
apps/daemon/src/runtime/agentRuntime.ts
apps/daemon/src/runtime/safetyGuard.ts
```

Files now intentionally removed from the old path:

```text
apps/daemon/src/repositories/memoryRepository.ts
```

## 12. Dependency Direction

Current runtime dependencies:

- `ai@^6`
- `@ai-sdk/openai`
- `@ai-sdk/anthropic`
- `zod`

Planned later:

- `@modelcontextprotocol/sdk`
- ACP-facing adapter packages if needed

## 13. Non-Goals

Not part of v2:

- LangChain
- PostgreSQL or Redis
- vector database
- Docker sandbox
- external agent SDK owning the runtime

## 14. Working Commands

```bash
npm run dev:daemon
npm run dev:desktop
npm run typecheck
npm run build
```

Useful smoke checks:

```bash
npm run smoke:tasks --workspace @aliceloop/daemon
npm run smoke:tasks:api --workspace @aliceloop/daemon
```

Useful daemon endpoints:

```bash
curl http://127.0.0.1:3030/health
curl http://127.0.0.1:3030/api/providers
curl http://127.0.0.1:3030/api/runtime/catalog
curl http://127.0.0.1:3030/api/attention
```
