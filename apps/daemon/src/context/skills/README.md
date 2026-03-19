# Aliceloop Skill Catalog

`apps/daemon/src/context/skills/` is the canonical project skill catalog.

Each skill lives in its own directory and is defined by a `SKILL.md` file with YAML frontmatter.

Current conventions:

- `name`: stable skill id
- `label`: optional UI label
- `description`: short routing hint for the model and desktop catalog
- `status`: `available` or `planned`
- `mode`: currently `instructional`
- `allowed-tools`: native Aliceloop tools or planned adapter tools
- `source-url`: optional provenance link

These files are loaded into:

- the desktop runtime catalog (`/api/skills`)
- the daemon system prompt as a discoverable skill index

They are not executable endpoints by themselves. Runnable capabilities live in:

- `/api/tasks`
- `/api/runtime/scripts`
- `apps/daemon/src/context/tools/`
