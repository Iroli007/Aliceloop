---
name: xiaohongshu
label: xiaohongshu
description: Use for Xiaohongshu / 小红书 / Rednote tasks: login status, search notes and users, read note details and comments, browse feeds and hot lists, like, favorite, comment, reply, follow, and creator-facing note workflows.
status: available
mode: instructional
source-url: https://github.com/jackwener/xiaohongshu-cli
allowed-tools:
  - bash
---

# Xiaohongshu

This skill wraps the upstream `xiaohongshu-cli`, adapted to Aliceloop.

Use the bundled helper script for every invocation:

```bash
skills/xiaohongshu/scripts/xhs --help
skills/xiaohongshu/scripts/xhs status --yaml
skills/xiaohongshu/scripts/xhs search "美食" --json
```

The helper prefers a locally installed `xhs`, then falls back to `uvx`, then `uv tool run`.

## Fit

Use this skill when the task is Xiaohongshu-specific and benefits from a structured CLI surface rather than ad-hoc browsing. Good fits include:

- search, feeds, hot lists, user pages, and note detail reads
- comments, sub-comments, favorites, notifications, and my-notes
- explicit like, favorite, comment, reply, follow, unfollow, post, or delete actions

Representative examples:

```bash
skills/xiaohongshu/scripts/xhs read "<note_url_or_id>" --json
skills/xiaohongshu/scripts/xhs comments "<note_url_or_id>" --all --json
skills/xiaohongshu/scripts/xhs search "美食" --sort popular --type video --json
skills/xiaohongshu/scripts/xhs notifications --type mentions --json
skills/xiaohongshu/scripts/xhs post --title "标题" --body "正文" --images /path/to/a.jpg /path/to/b.jpg
```

## Operating Rules

- When the task depends on account state, check `skills/xiaohongshu/scripts/xhs status --yaml` instead of guessing.
- If authentication is missing and the user needs a visible QR page or captcha handoff, switch to the browser skill instead of forcing everything through the CLI.
- Do not parallelize `xhs` requests.
- Prefer `--json` or `--yaml` when the output will be parsed.
- Prefer a full Xiaohongshu URL over a bare note ID when the user has one.
- Treat cookies as secrets. Never ask the user to paste raw cookies into chat.
- Common failure cases are still the usual upstream ones: auth expired, verification required, or network/IP blocks.
