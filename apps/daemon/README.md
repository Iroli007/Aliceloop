你的恶作剧

本地常驻 daemon，也是 Aliceloop 的宿主 runtime。

职责：

- 会话、事件、任务、sandbox run 的 SQLite 真相层
- `context/` 上下文加载：prompt、session、memory、tools、skills、MCP client 占位
- `runtime/agentRuntime.ts` 多步 agent loop
- 六原子命令 sandbox：`read` / `grep` / `glob` / `write` / `edit` / `bash`
- 允许模型通过 `write` / `edit` + `bash` 生成并执行一次性 helper 脚本，但不扩张系统 tool surface
- `context/skills/` 下的 `SKILL.md` catalog
- managed task tools、runtime scripts、model gateway config catalog
- SSE session stream 与桌面端同步
- artifact 与 memory distillation 编排

当前模型网关层：

- `MiniMax`
- `AIHubMix`
- `OpenAI`
- `Anthropic`
- `OpenRouter`
- `AIHubMix` 默认走 `https://aihubmix.com/v1`
- `transport=auto` 时，`claude*` 模型走 Anthropic 兼容接口，其余模型走 OpenAI 兼容接口

后续扩展方向：

- MCP client 深化：继续把已安装目录接到真实 transport，不暴露 Aliceloop 自身为 MCP server
- ACP 兼容的外部 engine adapters
- Claude Code / Codex / Gemini CLI 接入
