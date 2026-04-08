# Aliceloop Skill Catalog

`skills/` is the canonical project skill catalog.

Each skill lives in its own directory and is defined by a `SKILL.md` file with YAML frontmatter.

Current conventions:

- required frontmatter: `name`, `description`
- common optional frontmatter: `allowed-tools`, `source-url`
- `label`: optional, and should be omitted unless it differs from `name`
- `status`: optional, and should be omitted for normal active skills; use it only for non-default states such as `planned`
- `mode`: optional, and should be omitted unless a skill truly needs a non-default mode
- `allowed-tools`: the minimal tool surface a skill expects when it is relevant; this is documentation and search metadata, not a dynamic tool-loading mechanism
- frontmatter keys must be unique; duplicate keys are rejected at load time
- use `allowed-tools`, not legacy `tools`
- skill bodies should be AI-native capability prompts, not workflow scripts
- prefer semantic boundaries and evidence rules over workflow-style trigger writing
- command examples are allowed, but they should support the capability description rather than define the skill itself

These files are loaded into:

- the active desktop runtime catalog (`/api/skills`)
- the daemon system prompt as a discoverable skill index

The TypeScript selection and loader code still lives under:

- `apps/daemon/src/context/skills/`

But new or edited project skills should go in the top-level `skills/` directory, not inside daemon source code.

Several available skills use the local `aliceloop` CLI as their execution guide.

They are not executable endpoints by themselves. Runnable capabilities live in:

- `/api/tasks`
- `/api/runtime/scripts`
- `apps/daemon/src/context/tools/`

Memory-layer skill map:

- Conversation Buffer: prompt-only, not a skill
- Task Working Memory: `tasks`, `plan-mode`, `todo`, `scheduler`, `notebook`
- Profile / Fact Memory: `memory-management`
- Episodic History Recall: `memory-management`
- Thread Administration: `thread-management`
- Support State: `self-management`, `reactions`

These memory skills are invoked on demand through selection. Their underlying memory stores are not auto-loaded into the prompt as a separate memory layer.

Current runtime assembly rules:

- skills are selected as instruction text only
- non-base tools are selected separately by `apps/daemon/src/context/tools/toolRouter.ts`
- concrete adapter factories live in `apps/daemon/src/context/tools/skillToolFactories.ts`
- `status: planned` skills stay out of the active runtime catalog and routing path until the runtime can genuinely support them
