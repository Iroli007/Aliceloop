# Aliceloop Skill Catalog

`apps/daemon/src/context/skills/` is the canonical project skill catalog.

Each skill lives in its own directory and is defined by a `SKILL.md` file with YAML frontmatter.

Current conventions:

- `name`: stable skill id
- `label`: optional UI label
- `description`: short routing hint for the model and desktop catalog
- `status`: `available` or `planned`
- `mode`: currently `instructional`
- `allowed-tools`: canonical tool ids such as `bash`, `read`, `web_fetch`, or adapter ids like `browser_navigate`
- `source-url`: optional provenance link
- frontmatter keys must be unique; duplicate keys are rejected at load time
- use `allowed-tools`, not legacy `tools`

These files are loaded into:

- the desktop runtime catalog (`/api/skills`)
- the daemon system prompt as a discoverable skill index

Several available skills use the local `aliceloop` CLI as their execution guide.

They are not executable endpoints by themselves. Runnable capabilities live in:

- `/api/tasks`
- `/api/runtime/scripts`
- `apps/daemon/src/context/tools/`

Current runtime assembly rules:

- `status: available` skills may contribute additional tool adapters through `allowed-tools`
- those adapters are assembled by `apps/daemon/src/context/tools/toolRegistry.ts`
- adapter factories live in `apps/daemon/src/context/tools/skillToolFactories.ts`
- daemon startup validates that all active-skill adapters are resolvable before serving requests
- unresolved non-base tool names in an `available` skill now fail fast during live tool assembly
- `status: planned` skills remain catalog / prompt entries only until a real adapter exists
