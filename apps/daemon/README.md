# @aliceloop/daemon

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

能力恢复原则：

- 缺能力时优先走结构化恢复：`use_skill`、延迟工具加载、文本 tool-call repair。
- 尽量不要靠持续扩张 query 正则去挽救特殊 case。query continuation 主要负责补全上文省略信息，不负责把每种意图硬编码成路由规则。
- 用户不应该看到“先加载搜索技能/工具”这类中间话。runtime 应该尽量无感恢复，再继续执行真实任务。

后续扩展方向：

- MCP client 深化：继续把已安装目录接到真实 transport，不暴露 Aliceloop 自身为 MCP server
- ACP 兼容的外部 engine adapters
- Claude Code / Codex / Gemini CLI 接入
