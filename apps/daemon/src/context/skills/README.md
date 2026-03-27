# Aliceloop Skill Catalog

`/Users/raper/workspace/Projects/Aliceloop/skills/` is the canonical project skill catalog.

Each skill lives in its own directory and is defined by a `SKILL.md` file with YAML frontmatter.

Current conventions:

- `name`: stable skill id
- `label`: optional UI label
- `description`: short routing hint for the model and desktop catalog
- `status`: `available` or `planned`
- `mode`: currently `instructional`
- `allowed-tools`: the minimal tool surface a skill expects when it is relevant; this is documentation and routing metadata, not a dynamic tool-loading mechanism
- `source-url`: optional provenance link
- frontmatter keys must be unique; duplicate keys are rejected at load time
- use `allowed-tools`, not legacy `tools`

These files are loaded into:

- the desktop runtime catalog (`/api/skills`)
- the daemon system prompt as a discoverable skill index

The TypeScript routing and loader code still lives under:

- `/Users/raper/workspace/Projects/Aliceloop/apps/daemon/src/context/skills/`

But new or edited project skills should go in the top-level `skills/` directory, not inside daemon source code.

Several available skills use the local `aliceloop` CLI as their execution guide.

They are not executable endpoints by themselves. Runnable capabilities live in:

- `/api/tasks`
- `/api/runtime/scripts`
- `apps/daemon/src/context/tools/`

Memory-layer skill map:

- Conversation Buffer: prompt-only, not a skill
- Task Working Memory: `tasks`, `continue`, `plan-mode`, `todo`, `scheduler`, `notebook`
- Session Summary: `self-reflection`
- Profile / Fact Memory: `memory-management`
- Episodic History: `thread-management`
- Support State: `self-management`, `reactions`

These memory skills are invoked on demand through routing. Their underlying memory stores are not auto-loaded into the prompt as a separate memory layer.

Current runtime assembly rules:

- skills are routed as instruction text only
- non-base tools are routed separately by `apps/daemon/src/context/tools/toolRouter.ts`
- concrete adapter factories live in `apps/daemon/src/context/tools/skillToolFactories.ts`
- `status: planned` skills remain catalog / prompt entries only until the runtime can genuinely support them
