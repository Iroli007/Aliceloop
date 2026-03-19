# Aliceloop Project Spec v2

## 1. Product

Aliceloop is a desktop-first local coding and computer-use agent.

Core idea:

- Aliceloop owns the host runtime
- providers only supply reasoning
- the built-in agent loop operates through four atomic primitives: `read`, `write`, `edit`, `bash`
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

- `apps/desktop`: Electron shell, session UI, provider settings, runtime catalogs
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
- provider configs

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

This replaced the old MiniMax-specific reply path.

## 6. Tool Model

The base capability layer is:

- `sandbox_read`
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

Skills are no longer masquerading as runnable task entries. The `SKILL.md` catalog is injected into context for routing and behavior guidance, while executable capabilities stay in `context/tools/`.

Managed task tools currently cover:

- document ingest
- review coach
- runtime scripts

## 7. Provider Layer

Provider orchestration is unified behind Vercel AI SDK.

Supported provider kinds:

- `minimax`
- `openai`
- `anthropic`
- `openrouter`

Current implementation rules:

- `MiniMax`, `OpenAI`, and `OpenRouter` use OpenAI-compatible transport
- `Anthropic` uses the Anthropic SDK transport
- provider settings stay user-editable in the desktop shell

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
- Phase 3: provider/domain/schema updates
- Phase 4: daemon wiring and MiniMax-specific cleanup
- Phase 5: memory injection and basic reflection
- Phase 6: `SKILL.md` catalog moved into `apps/daemon/src/context/skills/`

Still pending:

- first-class MCP client integration with app-market install flow for user-installed servers
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
apps/daemon/src/services/minimaxRunner.ts
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
