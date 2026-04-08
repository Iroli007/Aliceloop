---
name: notebook
description: Edit Jupyter notebook (.ipynb) cells - insert, replace, reorder, or delete cells. Use when working with notebooks in Aliceloop.
allowed-tools:
  - bash
  - read
  - write
---

# Notebook Skill

Modify Jupyter notebook cells through `bash` with `jq`, then verify the result with `read`.

## When To Use

Use this skill when the user wants to:

- inspect notebook cell structure
- replace a cell's source
- insert a new markdown or code cell
- delete or reorder cells
- patch notebook JSON without opening Jupyter

## Core Workflow

1. Read the notebook or inspect its JSON structure first.
2. Use `bash` with `jq` to make structural edits.
3. Re-read the notebook JSON to confirm the change landed in the expected cell.
4. Prefer small, targeted edits instead of rewriting the whole notebook.

## List Cells

```bash
jq -r '.cells | to_entries[] | "\(.key): [\(.value.cell_type)] id=\(.value.id // "none") | \(.value.source[:1] | .[0] // "" | .[0:80])"' NOTEBOOK.ipynb
```

## Replace A Cell's Source

```bash
jq --arg src "print(\"hello world\")\n" \
  '.cells[0].source = ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1])' \
  NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Insert A New Code Cell

```bash
jq --arg src "# New cell\nprint(42)\n" \
  '.cells |= (.[0:3] + [{
    "id": ("new-" + (now | tostring)),
    "cell_type": "code",
    "source": ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1]),
    "metadata": {},
    "outputs": [],
    "execution_count": null
  }] + .[3:])' \
  NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Insert A Markdown Cell

```bash
jq --arg src "## Notes\nNotebook summary here.\n" \
  '.cells |= (.[0:1] + [{
    "id": ("new-" + (now | tostring)),
    "cell_type": "markdown",
    "source": ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1]),
    "metadata": {}
  }] + .[1:])' \
  NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Delete A Cell

```bash
jq 'del(.cells[1])' NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Reorder Cells

```bash
jq '.cells |= ([.[0], .[2], .[1]] + .[3:])' NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Tips

- Always inspect the notebook before editing so you target the right cell index.
- Notebook `source` arrays should keep trailing `\n` on each line except the last line.
- Use `jq` for structural edits; do not hand-edit large notebook JSON blobs unless the change is trivial.
- For risky edits, make a backup first with `cp NOTEBOOK.ipynb NOTEBOOK.ipynb.bak`.
- After editing, use `read` to confirm the notebook still contains the expected cell order and content.
