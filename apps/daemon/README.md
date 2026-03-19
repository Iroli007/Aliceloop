# @aliceloop/daemon

本地常驻 daemon，也是 Aliceloop 的宿主 runtime。

职责：

- 会话、事件、任务、sandbox run 的 SQLite 真相层
- `context/` 上下文加载：prompt、session、memory、tools、skills、MCP client 占位
- `runtime/agentRuntime.ts` 多步 agent loop
- 四原语 sandbox：`read` / `write` / `edit` / `bash`
- `context/skills/` 下的 `SKILL.md` catalog
- managed task tools、runtime scripts、provider config catalog
- SSE session stream 与桌面端同步
- artifact 与 memory distillation 编排

当前 provider 层：

- `MiniMax`
- `OpenAI`
- `Anthropic`
- `OpenRouter`

后续扩展方向：

- MCP client 集成：只连接用户从应用市场安装的 MCP 服务，不暴露 Aliceloop 自身为 MCP server
- ACP 兼容的外部 engine adapters
- Claude Code / Codex / Gemini CLI 接入
