# Aliceloop 架构审查报告

- 日期：2026-04-19
- 范围：`apps/daemon`、`apps/desktop`、`packages/runtime-core`、`packages/pdf-ingest`
- 目的：记录当前架构冗余、耦合、精度偏差与改造优先级，并作为后续逐步整改的执行底单

## 一句话结论

项目骨架方向没有错，但应用层已经出现明显的重复建模和职责外溢。最热的 7 个文件累计约 12,318 行，问题核心不是“代码多”，而是同一份会话状态、同一份意图路由、同一份工具生命周期，被多层重复解释和维护。

## 重点观察

- 代码热点集中在：
  - `apps/daemon/src/server.ts`
  - `apps/daemon/src/repositories/sessionRepository.ts`
  - `apps/daemon/src/runtime/agentRuntime.ts`
  - `apps/daemon/src/context/session/sessionContext.ts`
  - `apps/daemon/src/context/memory/memoryRepository.ts`
  - `apps/desktop/src/renderer/src/features/shell/ShellLayout.tsx`
  - `apps/desktop/src/renderer/src/features/shell/useShellConversation.ts`
- `apps/daemon/src/server.ts` 当前承载约 93 个 route，已经超出单文件可控范围。
- `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx` 存在接口漂移，说明前后端契约和前端桥接层有失配迹象。

## 优先级结论

### P0

#### 1. 会话真相源重复

- 现状：
  - 后端 snapshot：`apps/daemon/src/repositories/sessionRepository.ts`
  - 原始事件流和 SSE：`apps/daemon/src/server.ts`
  - 前端本地 reducer / timeline 重建：`apps/desktop/src/renderer/src/features/shell/useShellConversation.ts`、`apps/desktop/src/renderer/src/features/shell/ShellLayout.tsx`
- 问题：
  - 同一份 tool lifecycle、会话进度、重连恢复状态被多处重复投影。
  - 任何一处语义变化都容易造成前后端慢性漂移。
- 影响：
  - 重连一致性差。
  - UI 需要自己猜 runtime 状态。
  - 调试困难，回放不稳定。
- 建议：
  - 保留 event log，但由后端统一投影出前端直接消费的 `SessionSnapshot` 结构。
  - 前端只做渲染和轻量增量应用，不再自己重建完整 tool workflow。
- 当前进度：
  - 已开始。
  - 本轮先把 `toolWorkflowEntries` 收回到共享 contract 和 snapshot，作为第一刀。

### P1

#### 2. 意图路由分散，重复判断同一问题

- 涉及文件：
  - `apps/daemon/src/context/skills/skillRouting.ts`
  - `apps/daemon/src/context/tools/toolRouter.ts`
  - `apps/daemon/src/context/session/sessionContext.ts`
  - `apps/daemon/src/context/index.ts`
- 问题：
  - skill 选择、tool 选择、continuation hint、first-step tool choice 分散在多个模块里独立判断。
- 影响：
  - 行为不可预测。
  - prompt 和路由逻辑互相打架。
  - 精准度难以稳定提升。
- 建议：
  - 定义统一的 typed `IntentDecision`，由一个决策点产出，其他模块消费。

#### 3. `agentRuntime` 过度耦合

- 涉及文件：
  - `apps/daemon/src/runtime/agentRuntime.ts`
- 问题：
  - provider transport、MiniMax 特判、tool orchestration、流式落库、能力恢复、后处理调度混在一起。
- 影响：
  - provider 差异泄漏到 core loop。
  - 测试切面模糊。
  - 新 provider / 新 tool 容易继续堆补丁。
- 建议：
  - 切成 provider adapter、tool orchestration、stream persistence / post-processing 三段。

#### 4. `sessionContext` 用 prompt 工程替代显式状态

- 涉及文件：
  - `apps/daemon/src/context/session/sessionContext.ts`
- 问题：
  - `Active Turn`、`Research Memory`、`Task Working Memory` 等 block 过重。
- 影响：
  - token 成本高。
  - 评估难。
  - 行为更多依赖 prompt 拼接而不是 typed runtime state。
- 建议：
  - 把稳定的执行态和任务态前移为显式模型，减少 prompt 补状态。

#### 5. `server.ts` 已经是 god file

- 涉及文件：
  - `apps/daemon/src/server.ts`
- 问题：
  - HTTP 路由、启动回填、scheduler、browser relay 生命周期塞进同一入口。
- 影响：
  - 领域边界模糊。
  - 任意改动都容易扩大影响面。
- 建议：
  - 按 session、memory、runtime、provider、browser、mcp 等域拆 route modules。

### P2

#### 6. typed runtime 中夹杂字符串隧道

- 涉及文件：
  - `apps/daemon/src/context/tools/browserTool.ts`
  - `apps/daemon/src/context/session/sessionContext.ts`
- 问题：
  - tool 输出被 `JSON.stringify(...)` 后再在下游重新 `JSON.parse(...)` 猜回来。
- 影响：
  - 类型信息丢失。
  - 输出语义不稳定。
  - 容易出现“看起来 typed，实际上全靠约定”的伪类型系统。
- 建议：
  - 对 tool output 建立明确的 structured payload contract。

#### 7. `sessionRepository` 职责越界

- 涉及文件：
  - `apps/daemon/src/repositories/sessionRepository.ts`
- 问题：
  - 已同时承担 repository、event store、runtime presence 聚合、conversation projection 等职责。
- 影响：
  - 文件规模继续膨胀。
  - 很难形成清晰的读模型 / 写模型边界。
- 建议：
  - 将 event projection、snapshot aggregation、message write path 逐步拆开。

#### 8. 前端重复维护运行时语义

- 涉及文件：
  - `apps/desktop/src/renderer/src/features/shell/useShellConversation.ts`
  - `apps/desktop/src/renderer/src/features/shell/ShellLayout.tsx`
- 问题：
  - 前端本地持有 snapshot、event list、tool workflow projection、timeline 拼接逻辑。
- 影响：
  - 前端越来越像第二个 runtime。
  - UI 迭代成本高。
- 建议：
  - 后端多给投影，前端少做语义重建。

#### 9. 工程纪律开始漂移

- 现状：
  - 数据库初始化和 preview / seed 内容混杂。
  - 测试更偏 smoke，缺少稳定契约验证。
  - 当前 `typecheck` 曾出现设置页接口漂移。
- 建议：
  - 优先补齐会话快照、tool workflow、bridge 接口的类型契约检查。

### P3

#### 10. 仓库边界有历史层积物

- 现状：
  - 根目录同时存在 `npm` workspace 迹象与 `pnpm-workspace.yaml`
  - 保留 `skills-backups/`
- 影响：
  - 新成员理解成本高。
  - 容易误判当前真实工作流。
- 建议：
  - 等核心 runtime 收口后再清理仓库层历史遗留物。

## 建议保留的部分

- `packages/runtime-core/src/domain.ts`
  - shared contract 方向是对的。
- `packages/pdf-ingest/src/pipeline.ts`
  - 规模克制，没有假装自己已经是重型系统。
- `desktop + daemon + runtime-core`
  - 分层思路没错，问题主要出在 app 层边界没有继续守住。

## 分阶段整改顺序

### 第一阶段：先消除重复真相源

1. 把 `toolWorkflowEntries` 收口到共享 contract 和后端 snapshot。
2. 让前端停止本地维护第二份 tool workflow 状态。
3. 后续继续把 timeline / active turn 等投影往后端挪。

### 第二阶段：统一意图决策入口

1. 合并 skill routing、tool routing、first-step tool choice、continuation hint。
2. 引入统一的 `IntentDecision` 结果对象。

### 第三阶段：拆 runtime 和 server

1. 从 `agentRuntime.ts` 拆 provider adapter。
2. 从 `server.ts` 按领域拆 route module。

### 第四阶段：清理字符串隧道和仓储职责

1. 为 browser / web tool 建立明确结构化输出。
2. 将 `sessionRepository` 的 projection 责任外移。

## 整改进展

- 第一阶段已启动：会话 tool workflow 的单一真相源。
  - 共享 `ToolWorkflowEntry` contract。
  - 由后端 snapshot 输出 `toolWorkflowEntries`。
  - 前端消费 snapshot，不再维护独立副本。
- 第二阶段已启动：统一意图决策入口。
  - 新增 `TurnIntentDecision`。
  - `skillLoader`、`toolRouter`、`context/index` 的路由判断开始消费同一份决策结果。
  - `sessionContext` 的 continuation / research carry-forward hints 已切到同一入口。
- 第三阶段已启动：拆 `agentRuntime.ts`。
  - 新增 provider runtime adapter。
  - transport 解析、reasoning provider options、MiniMax 输出渲染过滤已从 core runtime 文件移出。
  - 新增 capability recovery module。
  - missing tool / intent-driven recovery / capability failure reply 已从 core runtime 文件移出。
  - 新增 MiniMax text tool fallback module。
  - MiniMax 文本工具调用解析、fallback tool 执行、二次生成回复已从 core runtime 文件移出。
  - 新增 stream persistence module。
  - 文本 delta 落库、debounced update、checkpoint、provider metadata 诊断已从 core runtime 文件移出。
  - 新增 tool orchestration module。
  - tool state event、tool start/finish、审批事件、tool perf trace、工具截图附件触发已从 core runtime 文件移出。
  - 新增 workset settlement module。
  - workset 打分、衰减、tool-call 反推 skill 使用已从 core runtime 文件移出。
  - 修正 workset 结算：本轮直接路由命中的 skill 不再因为没有工具调用而被误判为 idle；仅由旧 workset 带入且持续未命中的 skill 仍会自然衰减。
  - 新增 post-processing module。
  - artifact 写入、turn reflection、自动记忆写入已从 core runtime 文件移出，并保持 fire-and-forget 语义。
- 第三阶段已启动：拆 `server.ts`。
  - 新增 route module 目录。
  - provider routes 已迁移到 `routes/providerRoutes.ts`。
  - MCP server routes 已迁移到 `routes/mcpRoutes.ts`。
  - runtime script routes 已迁移到 `routes/runtimeScriptRoutes.ts`。

## 下一步

- 继续拆 `server.ts` 的 session / runtime / project route modules。

后续整改将继续按这个报告里的优先级推进，而不是同时做大范围重构。
