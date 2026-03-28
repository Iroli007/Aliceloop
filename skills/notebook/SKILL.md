---
name: notebook
description: Inspect and edit Jupyter notebook cells with bash and JSON-aware tools.
allowed-tools:
  - bash
  - read
  - write
---

# Notebook

Use this skill when the task is specifically about `.ipynb` files.

## Commands

```bash
jq -r '.cells | to_entries[] | "\(.key): [\(.value.cell_type)] \(.value.source[:1] | .[0] // "" | .[0:80])"' NOTEBOOK.ipynb

jq --arg src "print(\"hello world\")\n" \
  '.cells[0].source = ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1])' \
  NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb

jq 'del(.cells[1])' NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
```

## Tips

- Inspect cell indexes before editing.
- Keep notebook JSON valid and preserve outputs unless the user wants them cleared.
- Use a temp file for rewrites instead of editing in place blindly.
