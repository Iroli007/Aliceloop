---
name: xiaohongshu
label: xiaohongshu
description: Use for Xiaohongshu / 小红书 / Rednote workflows such as login, search, note reading, account inspection, interaction, and posting through the `xhs` CLI.
status: available
mode: instructional
source-url: https://github.com/jackwener/xiaohongshu-cli
allowed-tools:
  - bash
---

# Xiaohongshu

Use this skill for Xiaohongshu tasks that are better served by the `xhs` command-line client than by browser scraping.

Examples:

- check whether an account is logged in
- search notes, users, or topics
- read a note and its comments
- like, favorite, comment, follow, or post
- inspect inbox or creator activity

## Runtime

Use `xhs` directly when it is installed.
If it is not installed, replace `xhs` in the examples below with `uvx --from xiaohongshu-cli xhs`.

For repeated usage, install it once:

```bash
xhs --help
uv tool install xiaohongshu-cli
uv tool upgrade xiaohongshu-cli
```

## Operating Rules

- Do not parallelize `xhs` requests. The upstream client already includes pacing and retry logic for account safety.
- Prefer `--json` or `--yaml` when the result will be parsed. Non-TTY stdout already defaults to YAML.
- Prefer a full Xiaohongshu URL over a bare note ID when the user has one. `read` and `comments` can extract and cache the `xsec_token` from the URL.
- Treat cookies as secrets. Never ask the user to paste raw cookies into chat.

## Authentication Workflow

Always check auth before any write action, and before longer read workflows:

```bash
xhs status --yaml
```

If authentication is missing or expired:

```bash
# Browser cookie extraction
xhs login

# Optional: choose a browser explicitly
xhs login --cookie-source arc

# QR login if browser cookie extraction is unavailable
xhs login --qrcode
```

Verify after login:

```bash
xhs whoami --yaml
```

Common recovery paths:

- `not_authenticated`: rerun `xhs login`
- `verification_required`: ask the user to complete the captcha in a browser, then retry
- `ip_blocked`: suggest changing network, hotspot, or VPN

## Command Guide

### Read and Discover

```bash
xhs search "美食" --sort popular --type video --json
xhs read "<note_url_or_id>" --json
xhs comments "<note_url_or_id>" --all --json
xhs sub-comments <note_id> <comment_id> --json
xhs user <user_id> --json
xhs user-posts <user_id> --json
xhs topics "旅行" --json
xhs search-user "摄影" --json
xhs feed --json
xhs hot -c food --json
```

`hot` categories: `fashion`, `food`, `cosmetics`, `movie`, `career`, `love`, `home`, `gaming`, `travel`, `fitness`

### Interactions and Social

```bash
xhs like <note_id_or_url>
xhs like <note_id_or_url> --undo
xhs favorite <note_id_or_url>
xhs unfavorite <note_id_or_url>
xhs comment <note_id_or_url> -c "好看"
xhs reply <note_id_or_url> --comment-id <comment_id> -c "谢谢"
xhs delete-comment <note_id> <comment_id>
xhs follow <user_id>
xhs unfollow <user_id>
xhs favorites --json
xhs favorites <user_id> --json
```

### Creator and Inbox

```bash
xhs my-notes --json
xhs post --title "标题" --body "正文" --images /path/to/a.jpg /path/to/b.jpg
xhs delete <note_id> -y
```

**Newlines in post body**: Bash single-quoted strings do NOT interpret `\n`.
Use `printf` to produce real newlines:

```bash
BODY=$(printf '第一段落\n\n第二段落\n\n第三段落')
xhs post --title "标题" --body "$BODY" --images /path/to/img.jpg
xhs unread --json
xhs notifications --type mentions --json
xhs notifications --type likes --json
xhs notifications --type connections --json
```

## Structured Output

Machine-readable output uses this envelope:

```yaml
ok: true
schema_version: "1"
data: ...
```

Errors use:

```yaml
ok: false
schema_version: "1"
error:
  code: not_authenticated
  message: ...
```

Common `error.code` values:

- `not_authenticated`
- `verification_required`
- `ip_blocked`
- `signature_error`
- `unsupported_operation`
- `api_error`

## Recommended Flows

Search, inspect, then act:

```bash
NOTE_ID=$(xhs search "露营" --json | jq -r '.data.items[0].id')
xhs read "$NOTE_ID" --json
xhs like "$NOTE_ID"
```

Use pasted URLs for richer analysis:

```bash
xhs read "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy" --json
xhs comments "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy" --all --json
```

## Limitations

- No DM support
- No live-stream features
- No following/followers list API
- No media download support in the upstream CLI
- One account session at a time
- Posting support is centered on image notes
