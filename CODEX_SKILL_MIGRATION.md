# Codex Task: Skill 体系大扩展 — 从 Alma 偷技能到 Aliceloop

## 背景

Aliceloop 当前保留的核心技能目录已经基本迁移完成；`coding-agent`、`web-fetch`、`web-search`、`browser` 都已经是 `available`。

参考 Alma（一个成熟的 AI agent 项目）的 32 个 skills 体系，将其核心设计移植到 Aliceloop，大幅扩展能力边界。

## 核心设计哲学（从 Alma 学到的）

### Alma 的 "Bash 万能通道" 模式

Alma 表面上只有 6 个底层工具（Bash, Read, Write, Glob, Grep, Task），但通过 `alma xxx` CLI 命令体系，让模型通过 Bash 调用一切能力。Skill 的 SKILL.md 本质上是"CLI 使用手册"。

**Aliceloop 的适配**：我们用 `aliceloop` CLI（需要新建）作为统一命令入口，skill 的 allowed-tools 主要声明 `bash`（以及必要的 `read`/`write`），SKILL.md 里教模型怎么用 `aliceloop xxx` 命令。

### 架构差异保留

Aliceloop 保留自己的优势：
- **类型安全的工具注册**：`skillToolFactories.ts` + `assertResolvableSkillTools()` fail-fast 校验
- **真正的工具权限控制**：不是所有 skill 都能拿到 Bash
- **planned skill 安全**：planned skill 引用不存在的工具名会被静默跳过，但 available skill 必须所有工具可解析

---

## 第一步：创建 `aliceloop` CLI 入口

### 文件：`apps/daemon/src/cli/index.ts`

创建一个 CLI 工具，作为所有 skill 能力的统一调用通道。子命令结构：

```
aliceloop <subcommand> [args...]
```

CLI 通过 HTTP 调用本地 daemon API（`http://localhost:<PORT>/api/...`），不直接操作数据库。

### 需要实现的子命令（按优先级排列）

#### P0 — 最小可用

| 子命令 | 说明 | 对应 Alma 命令 |
|--------|------|---------------|
| `aliceloop status` | 检查 daemon 是否运行 | `alma status` |
| `aliceloop memory list` | 列出记忆 | `alma memory list` |
| `aliceloop memory search <query>` | 语义搜索记忆 | `alma memory search` |
| `aliceloop memory add <content>` | 添加记忆 | `alma memory add` |
| `aliceloop memory delete <id>` | 删除记忆 | `alma memory delete` |
| `aliceloop config list` | 列出所有配置 | `alma config list` |
| `aliceloop config get <path>` | 读取配置 | `alma config get` |
| `aliceloop config set <path> <value>` | 设置配置 | `alma config set` |
| `aliceloop threads [limit]` | 列出会话线程 | `alma threads` |
| `aliceloop thread info <id>` | 线程详情 | `alma thread info` |

#### P1 — 浏览器 & 搜索

| 子命令 | 说明 | 实现方式 |
|--------|------|---------|
| `aliceloop browser status` | 检查浏览器连接状态 | 查询 PinchTab / Chrome Relay |
| `aliceloop browser tabs` | 列出标签页 | PinchTab API |
| `aliceloop browser read <tabId>` | 读取页面内容 | PinchTab text extraction |

#### P2 — 文件发送 & 截图

| 子命令 | 说明 |
|--------|------|
| `aliceloop send photo <path> [caption]` | 发送图片到当前会话 |
| `aliceloop send file <path> [caption]` | 发送文件到当前会话 |
| `aliceloop screenshot` | 截屏并返回路径 |

#### P3 — 任务管理

| 子命令 | 说明 |
|--------|------|
| `aliceloop tasks list [all\|done]` | 列出任务 |
| `aliceloop tasks add <title>` | 创建任务 |
| `aliceloop tasks update <id> [--steps ...] [--status ...]` | 更新任务 |
| `aliceloop tasks done <id>` | 完成任务 |

#### P4 — 高级能力（后续迭代）

| 子命令 | 说明 |
|--------|------|
| `aliceloop coding-agent run --dir <path> <task>` | 委托 Claude Code |
| `aliceloop image generate <prompt>` | AI 图片生成 |
| `aliceloop cron list/add/remove` | 定时任务 |

### CLI 实现要点

```typescript
// apps/daemon/src/cli/index.ts
// 用 process.argv 解析，不需要 commander/yargs 等依赖
// 通过 fetch("http://localhost:PORT/api/...") 调用 daemon
// 输出纯文本，方便模型解析
// package.json 里加 "bin": { "aliceloop": "./dist/cli/index.js" }
```

---

## 第二步：批量创建 Skills

### 新增 Skills 列表

根据 Alma 的 32 个 skills，筛选出适合 Aliceloop 的，分三批实现：

#### 第一批：available（有对应实现或只需 bash）

| Skill | status | allowed-tools | 说明 |
|-------|--------|---------------|------|
| `coding-agent` | available | bash, grep, glob, read, edit, write, coding_agent_run, document_ingest, review_coach | **已存在**，保持不变 |
| `web-fetch` | available | bash, web_fetch | **已存在**，已改为 available |
| `web-search` | available | bash, web_search, web_fetch | 已接入搜索适配与抓取链路 |
| `file-manager` | available | bash, read, write, grep, glob | 文件查找/整理/压缩，纯 bash 命令即可 |
| `system-info` | available | bash | 系统信息，纯 bash 命令 |
| `screenshot` | available | bash, read | macOS screencapture + sips resize |
| `notebook` | available | bash, read, write | Jupyter notebook 编辑，jq 操作 |
| `todo` | available | read, write | Markdown todo 文件，纯 read/write |
| `voice` | available | bash | macOS `say` 本地 TTS |

#### 第二批：available（需要 CLI 子命令或少量 API）

| Skill | status | allowed-tools | 依赖 |
|-------|--------|---------------|------|
| `memory-management` | available | bash, read, write | 需要 `aliceloop memory` 子命令 |
| `thread-management` | available | bash | 需要 `aliceloop threads` 子命令 |
| `self-management` | available | bash | 需要 `aliceloop config` 子命令 |
| `tasks` | available | bash | 需要 `aliceloop tasks` 子命令 |
| `scheduler` | available | bash, read, write | 需要 `aliceloop cron` 子命令 |
| `send-file` | available | bash | 需要 `aliceloop send` 子命令 |
| `image-gen` | available | bash, read | 需要 OpenAI-compatible `/images/generations` 后端 |
| `self-reflection` | available | bash, read, write | 已接入本地 reflection memory API |
| `plan-mode` | available | bash | 需要 `aliceloop plan` 子命令 |
| `skill-hub` | available | bash, read, write | 需要 `aliceloop skills` 子命令 |
| `reactions` | available | bash | 需要本地 session reaction API / CLI |

#### 第三批：剩余外部集成项

| Skill | status | allowed-tools | 说明 |
|-------|--------|---------------|------|
| `browser` | available | browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot | 本地 Playwright headless adapter 已接通 |
| `music-gen` | available | bash | 已接入本地 prompt-driven MIDI sketch CLI |
| `telegram` | available | bash | 已接入 Telegram Bot API CLI（`me` / `send` / `file`） |
| `discord` | available | bash | 已接入 Discord webhook CLI（文本 / 单文件上传） |

### 不移植的 Skills（Alma 特有/不适合 Aliceloop）

| Skill | 原因 |
|-------|------|
| `selfie` | Alma 的虚拟形象系统，与 Aliceloop 定位不同 |
| `travel` | 虚拟旅行系统，娱乐功能 |
| `music-listener` | 音频分析，优先级低 |
| `video-reader` | 视频分析，依赖 Gemini |
| `xiaohongshu-cli` | 平台特定 |
| `twitter-media` | 平台特定 |
| `skill-search` | Alma 的 skills.sh 生态特有 |

---

## 第三步：逐个编写 SKILL.md

所有 SKILL.md 文件放在 `apps/daemon/src/context/skills/<skill-name>/SKILL.md`。

### 格式规范

```yaml
---
name: <skill-id>
label: <display-name>
description: <一句话描述，供模型路由和 UI 展示>
status: available | planned
mode: instructional
allowed-tools:
  - bash
  - read  # 按需
  - write # 按需
---
```

### SKILL.md 内容模板

每个 SKILL.md 应包含：
1. **什么时候用**（When to Use）
2. **核心命令**（Commands）— 用 `aliceloop xxx` 或直接 bash 命令
3. **示例**（Examples）
4. **注意事项**（Tips/Rules）
5. **Aliceloop 状态**（如果是 planned，说明缺什么）

---

## 第四步：具体 SKILL.md 内容

### 4.1 `file-manager/SKILL.md`

```markdown
---
name: file-manager
label: file-manager
description: Find, organize, and manage files on the user's computer. Search by name, type, size, or date. Move, rename, compress, and clean up files.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
  - grep
  - glob
---

# File Manager

Help users find and organize files on their computer.

## Find Files

\`\`\`bash
# By name (case-insensitive)
find ~/Desktop ~/Documents ~/Downloads -iname "*report*" -type f 2>/dev/null

# By extension
find ~/Downloads -name "*.pdf" -type f

# By size (larger than 100MB)
find ~ -size +100M -type f 2>/dev/null | head -20

# Recently modified (last 7 days)
find ~/Documents -mtime -7 -type f | head -20
\`\`\`

## Organize

\`\`\`bash
# Move all PDFs from Downloads to Documents
mv ~/Downloads/*.pdf ~/Documents/

# Create dated folder and move files
mkdir -p ~/Documents/$(date +%Y-%m-%d)

# Rename files (pattern)
for f in *.jpeg; do mv "$f" "${f%.jpeg}.jpg"; done
\`\`\`

## Compress/Extract

\`\`\`bash
zip -r archive.zip folder/
tar czf archive.tar.gz folder/
unzip archive.zip
tar xzf archive.tar.gz
\`\`\`

## Tips
- Always preview file lists before bulk operations
- Ask before deleting — show what would be affected first
- Use `trash` over `rm` when available
```

### 4.2 `system-info/SKILL.md`

```markdown
---
name: system-info
label: system-info
description: Get system information — OS version, disk usage, memory, running processes, network status. Use when users ask about their computer status or system health.
status: available
mode: instructional
allowed-tools:
  - bash
---

# System Info

Gather system information using standard command-line tools.

## Commands

\`\`\`bash
# OS version
sw_vers                              # macOS
uname -a                             # Any Unix

# Disk usage
df -h

# Memory
top -l 1 -s 0 | head -12

# CPU
sysctl -n machdep.cpu.brand_string
sysctl -n hw.ncpu

# Running processes (top CPU/memory)
ps aux --sort=-%cpu | head -10
ps aux --sort=-%mem | head -10

# Network
ifconfig | grep "inet "
ping -c 1 8.8.8.8

# Battery (MacBook)
pmset -g batt

# Uptime
uptime
\`\`\`

## Tips
- Use `sw_vers` for macOS version details
- Use `system_profiler SPHardwareDataType` for full hardware info
- Use `lsof -i :PORT` to check what's running on a port
```

### 4.3 `screenshot/SKILL.md`

```markdown
---
name: screenshot
label: screenshot
description: Take screenshots of the screen using macOS screencapture. Use when users ask to see the screen, debug UI, or capture what's displayed.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
---

# Screenshot

Take screenshots using macOS `screencapture`.

## Important: Always Resize

Full-resolution screenshots on Retina displays produce huge images. Always resize before returning to the model.

## Take and View

\`\`\`bash
# 1. Capture full screen
/usr/sbin/screencapture -x -t jpg /tmp/aliceloop-screenshot.jpg

# 2. Resize to 1024px wide
/usr/bin/sips --resampleWidth 1024 --setProperty formatOptions 60 /tmp/aliceloop-screenshot.jpg --out /tmp/aliceloop-screenshot-thumb.jpg 2>/dev/null

# 3. Get dimensions
/usr/bin/sips -g pixelWidth -g pixelHeight /tmp/aliceloop-screenshot.jpg 2>/dev/null
\`\`\`

Then use `read` to view `/tmp/aliceloop-screenshot-thumb.jpg` (the resized version).

## Capture Options

\`\`\`bash
# Full screen (default)
/usr/sbin/screencapture -x -t jpg /tmp/aliceloop-screenshot.jpg

# Interactive window selection
/usr/sbin/screencapture -x -w -t jpg /tmp/aliceloop-screenshot.jpg

# Specific region
/usr/sbin/screencapture -x -R 0,0,800,600 -t jpg /tmp/aliceloop-screenshot.jpg

# With delay
/usr/sbin/screencapture -x -T 3 -t jpg /tmp/aliceloop-screenshot.jpg
\`\`\`

## Tips
- `-x` suppresses capture sound
- `-t jpg` outputs JPEG (smaller than PNG)
- Always resize before reading into context
```

### 4.4 `notebook/SKILL.md`

```markdown
---
name: notebook
label: notebook
description: Edit Jupyter notebook (.ipynb) cells — insert, replace, or delete cells. Use when working with notebooks.
status: available
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Notebook Edit

Modify Jupyter notebook cells using `jq` and bash.

## List Cells

\`\`\`bash
jq -r '.cells | to_entries[] | "\(.key): [\(.value.cell_type)] \(.value.source[:1] | .[0] // "" | .[0:80])"' NOTEBOOK.ipynb
\`\`\`

## Replace a Cell

\`\`\`bash
jq --arg src "print(\"hello world\")\n" \
   '.cells[0].source = ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1])' \
   NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
\`\`\`

## Insert a New Cell

\`\`\`bash
jq --arg src "# New cell\nprint(42)\n" \
   '.cells |= (.[0:3] + [{
     "cell_type": "code",
     "source": ($src | split("\n") | map(if . == "" then . else . + "\n" end) | .[:-1]),
     "metadata": {},
     "outputs": [],
     "execution_count": null
   }] + .[3:])' \
   NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
\`\`\`

## Delete a Cell

\`\`\`bash
jq 'del(.cells[1])' NOTEBOOK.ipynb > /tmp/nb_tmp.ipynb && mv /tmp/nb_tmp.ipynb NOTEBOOK.ipynb
\`\`\`

## Tips
- Always read the notebook first to understand structure
- Back up before complex edits
- Notebook source lines should end with `\n` except the last
```

### 4.5 `todo/SKILL.md`

```markdown
---
name: todo
label: todo
description: Manage a structured task list using a Markdown file in the workspace. Track progress on complex multi-step tasks.
status: available
mode: instructional
allowed-tools:
  - read
  - write
---

# Todo

Manage tasks using a Markdown file at `.aliceloop/todos.md` in the current workspace.

## File Format

\`\`\`markdown
# Todos

- [x] Fix authentication bug
- [ ] Add unit tests *(in progress)*
- [ ] Update documentation
\`\`\`

## Rules

- Use `read` to check current todos before changes
- Use `write` / `edit` to update the file
- Mark completed items with `[x]`
- Add `*(in progress)*` to show current work
- Keep items concise and actionable
```

### 4.6 `memory-management/SKILL.md`

```markdown
---
name: memory-management
label: memory-management
description: Search and manage Aliceloop's memory and conversation history. Use when the user asks about past conversations, personal facts, preferences, or anything that requires recalling information.
status: planned
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Memory Management

Aliceloop's memory system with semantic search.

## Commands

\`\`\`bash
aliceloop memory list
aliceloop memory search <query>
aliceloop memory add <content>
aliceloop memory delete <id>
aliceloop memory stats
\`\`\`

## When to Use

- User asks about past conversations
- User says "remember this" → `aliceloop memory add "..."`
- User asks "do you remember..." → `aliceloop memory search "..."`
- User says "forget about..." → search and delete matching memories

## Aliceloop Status

This skill requires the `aliceloop memory` CLI subcommand to be implemented. Until then:
- Use the existing memory context block in the system prompt
- Do not fabricate recalled information
```

### 4.7 `thread-management/SKILL.md`

```markdown
---
name: thread-management
label: thread-management
description: Manage chat threads — create, list, switch, and search conversations.
status: planned
mode: instructional
allowed-tools:
  - bash
---

# Thread Management

Manage Aliceloop chat threads.

## Commands

\`\`\`bash
aliceloop threads [limit]
aliceloop thread info <id>
aliceloop thread new [title]
aliceloop thread delete <id>
aliceloop thread search <query>
\`\`\`

## Aliceloop Status

Requires `aliceloop threads` CLI subcommand. Threads API already exists at `/api/sessions`.
```

### 4.8 `self-management/SKILL.md`

```markdown
---
name: self-management
label: self-management
description: Read and update Aliceloop's own settings via the CLI. Use when users ask to change models, providers, or any configuration.
status: planned
mode: instructional
allowed-tools:
  - bash
---

# Self-Management

Manage Aliceloop runtime settings.

## Commands

\`\`\`bash
aliceloop status
aliceloop config list
aliceloop config get <path>
aliceloop config set <path> <value>
aliceloop providers
\`\`\`

## Aliceloop Status

Requires `aliceloop config` CLI subcommand. Settings API already exists at `/api/runtime/settings` and `/api/providers`.
```

### 4.9 `tasks/SKILL.md`

```markdown
---
name: tasks
label: tasks
description: Global multi-step task tracking. Create, update, and monitor long-running tasks across sessions.
status: planned
mode: instructional
allowed-tools:
  - bash
---

# Tasks

Track complex, multi-step tasks globally.

## When to Use

- Starting a complex task with 3+ steps
- Need to track progress across sessions
- Long-running work that survives restarts

## Commands

\`\`\`bash
aliceloop tasks list [all|done]
aliceloop tasks add <title>
aliceloop tasks update <id> --steps "Step1,Step2,Step3"
aliceloop tasks update <id> --step 2 --status in_progress
aliceloop tasks done <id>
aliceloop tasks show <id>
aliceloop tasks delete <id>
\`\`\`

## Aliceloop Status

Requires `aliceloop tasks` CLI subcommand. Task API already exists at `/api/tasks`.
```

### 4.10 `scheduler/SKILL.md`

```markdown
---
name: scheduler
label: scheduler
description: Create, manage, and delete scheduled tasks (cron jobs). Use when users ask for reminders, recurring tasks, periodic checks, or anything time-based.
status: planned
mode: instructional
allowed-tools:
  - bash
  - read
  - write
---

# Scheduler

Schedule tasks and periodic checks.

## Commands

\`\`\`bash
aliceloop cron list
aliceloop cron add <name> at <schedule> --prompt "..."
aliceloop cron add <name> every <interval> --prompt "..."
aliceloop cron add <name> cron "<expression>" --prompt "..."
aliceloop cron remove <id>
aliceloop cron enable <id>
aliceloop cron disable <id>
\`\`\`

## Aliceloop Status

Requires `aliceloop cron` CLI subcommand and a cron scheduler in the daemon.
```

### 4.12 Planned skills（简要版）

以下条目最初是 planned / 外部集成型技能；其中大部分已经在本仓库内完成接通：

- `image-gen` — AI 图片生成（需要接入 Gemini/DALL-E/ComfyUI）
- `voice` — TTS 语音生成（需要接入 TTS 引擎）
- `music-gen` — 本地 MIDI 草图生成（已接入 CLI）
- `send-file` — 发送文件到会话（需要消息平台集成）
- `telegram` — Telegram Bot API（已接入 CLI）
- `discord` — Discord webhook（已接入 CLI）
- `self-reflection` — 日记 & 人格演化（需要日记系统）
- `reactions` — 消息表情回应（需要消息平台集成）
- `skill-hub` — 技能市场（需要市场生态）
- `plan-mode` — 规划模式（需要 plan-mode API）

每个都按上面的格式模板写最小 SKILL.md，重点写清 "Aliceloop Status" 说明缺什么。

---

## 第五步：更新 `skillToolFactories.ts`

当前 factory map 不需要改动，因为新增的 skill 大多只用 `bash` + `read` + `write`，这些都是 BASE_TOOL_NAMES，不需要额外的 factory。

唯一可能需要新增 factory 的场景：
- `web_search` 工具（当 web-search skill 变为 available 时）

---

## 第六步：更新 `coding-agent/SKILL.md`

在 allowed-tools 中补上动态的 `runtime_script_*` 前缀说明：

```yaml
allowed-tools:
  - grep
  - glob
  - read
  - edit
  - write
  - bash
  - coding_agent_run
  - document_ingest
  - review_coach
```

**已完成**（本次重构已改好）。

---

## 执行顺序

### Phase A: Skills 文件创建（无代码改动）

1. 创建以下目录和 SKILL.md：
   - `apps/daemon/src/context/skills/file-manager/SKILL.md`
   - `apps/daemon/src/context/skills/system-info/SKILL.md`
   - `apps/daemon/src/context/skills/screenshot/SKILL.md`
   - `apps/daemon/src/context/skills/notebook/SKILL.md`
   - `apps/daemon/src/context/skills/todo/SKILL.md`
   - `apps/daemon/src/context/skills/memory-management/SKILL.md`
   - `apps/daemon/src/context/skills/thread-management/SKILL.md`
   - `apps/daemon/src/context/skills/self-management/SKILL.md`
   - `apps/daemon/src/context/skills/tasks/SKILL.md`
   - `apps/daemon/src/context/skills/scheduler/SKILL.md`
   - `apps/daemon/src/context/skills/image-gen/SKILL.md`
   - `apps/daemon/src/context/skills/voice/SKILL.md`
   - `apps/daemon/src/context/skills/music-gen/SKILL.md`
   - `apps/daemon/src/context/skills/send-file/SKILL.md`
   - `apps/daemon/src/context/skills/telegram/SKILL.md`
   - `apps/daemon/src/context/skills/discord/SKILL.md`
   - `apps/daemon/src/context/skills/self-reflection/SKILL.md`
   - `apps/daemon/src/context/skills/reactions/SKILL.md`
   - `apps/daemon/src/context/skills/skill-hub/SKILL.md`
   - `apps/daemon/src/context/skills/plan-mode/SKILL.md`

2. 内容按上面第四步的模板填写

### Phase B: `aliceloop` CLI 骨架

1. 创建 `apps/daemon/src/cli/index.ts`
2. 实现 P0 子命令（status, memory, config, threads）
3. 在 `apps/daemon/package.json` 的 `bin` 字段注册
4. 确保 `npm run build` 后 CLI 可用

### Phase C: 激活第二批 Skills

当 CLI 子命令实现后，将对应 skill 的 status 从 `planned` 改为 `available`。

---

## 验证方式

1. `npx tsc --noEmit` 通过
2. 启动 daemon，`GET /api/runtime/state` 返回的 skills 列表包含所有新 skill
3. available skill 的 tools 在 `/api/runtime/state` 的 tools 列表中出现
4. planned skill 的 tools 不出现在 tools 列表中
5. `aliceloop status` 命令可执行

---

## 关键文件路径

- Skills 目录: `apps/daemon/src/context/skills/`
- Skill 加载器: `apps/daemon/src/context/skills/skillLoader.ts`（不需要改，自动扫描目录）
- 工具注册: `apps/daemon/src/context/tools/toolRegistry.ts`（不需要改）
- 工厂注册: `apps/daemon/src/context/tools/skillToolFactories.ts`（不需要改，除非新增非 base 工具）
- CLI 入口: `apps/daemon/src/cli/index.ts`（新建）
- Domain 类型: `packages/runtime-core/src/domain.ts`（不需要改）
