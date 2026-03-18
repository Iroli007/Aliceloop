# Aliceloop Project Spec

这份文档是 Aliceloop 当前阶段的执行型 spec。

它和 [AGENT_DESIGN_THINKING.md](/Users/raper/workspace/Projects/Aliceloop/AGENT_DESIGN_THINKING.md) 的区别是：

- `AGENT_DESIGN_THINKING.md` 负责长期设计原则
- `PROJECT_SPEC.md` 负责当前项目到底做到了哪里、还差什么、下一步怎么接着干

## 0. Aliceloop 1.0 定义

`Aliceloop 1.0` 指的是第一版**可持续演进的 runtime skeleton**，不是所有长期功能都已完成。

它至少意味着：

- monorepo 四个核心 workspace 已成立：`desktop`、`daemon`、`runtime-core`、`pdf-ingest`
- daemon、SQLite、session、tasks、sandbox、provider、runtime catalog 已接成真实链路
- 前后端已经可以围绕 live daemon 做会话、设置和只读状态联调
- 后续功能会在这条骨架上继续生长，而不是再推翻基础设施重写

因此 `1.0` 的重点是：

- 固定长期分层
- 固定运行时骨架
- 固定后续 git 提交纪律

对 `1.0` 这一条发布线来说，可以直接拍板：

- **后端骨架已经完成**
- 还没完成的是上层能力，而不是基础骨架本身

这里的“骨架完成”指的是：

- daemon / gateway 已有
- session / tasks / provider / runtime catalog 已有真实链路
- permission sandbox 已有统一执行 ABI
- per-session queue 已有
- 前后端已经能围绕 live daemon 联调

需要特别区分的一点：

- **agent loop 还没实现**
- 当前完成的是 runtime skeleton，不是完整的自主决策 loop
- 现在已有的是 provider runner、task runner、sandbox executor 和 session queue

还未完成但不再阻塞 1.0 skeleton 的，是：

- 更完整的 policy loop
- 更深的 memory governance
- 更成熟的 artifact 生成器
- Tele / remote continuity
- 更强的 PDF 理解质量

## 1. Product Scope

### 1.1 产品定义

Aliceloop 是一个：

- 桌面本体优先的本地 AI companion
- 可跨多个 surface 持续存在的 agent runtime
- 面向文档、任务、本机动作和工件生成的长期工作台

### 1.2 第一阶段目标

首版不是通用 Alma 克隆，不是 MCP 市场，不是 coding agent 产品。

首版只做这条主链路：

1. 导入本地 PDF / 网页 / 文本 / 附件
2. 快速定位相关结构、内容块和上下文
3. 生成学习型 artifact 或执行本机动作
4. 让用户感觉系统一直知道“最近在看什么”

### 1.3 首版输出

首版产出物不以卡片为主，而是：

- 学习页
- 专题页
- 晚间复习包

## 2. Current Status

### 2.1 已完成的部分

#### 仓库与工程骨架

- 仓库已重建，旧内容已清空
- Git 已重新初始化并连接远程
- monorepo 结构已建立：
  - `apps/desktop`
  - `apps/daemon`
  - `packages/runtime-core`
  - `packages/pdf-ingest`

#### 设计文档

- 已完成长期设计文档：
  - [AGENT_DESIGN_THINKING.md](/Users/raper/workspace/Projects/Aliceloop/AGENT_DESIGN_THINKING.md)
- 项目级 skill 定义统一放在：
  - `/skills/<skill-id>/SKILL.md`
- `apps/daemon/runtime-scripts` 只放脚本资源，不再充当 skill catalog

#### 桌面壳

- 已有 Electron 主进程骨架
- 已有 preload 桥接
- 已有 renderer React 壳
- 已补浏览器预览模式，不依赖 Electron 即可联调前端：
  - `npm run dev:web --workspace @aliceloop/desktop`

#### 桌面当前交互骨架

- 左侧栏 / 中间消息区 / 底部发送框结构已搭好
- 左下角设置入口已替换为“设置”按钮
- 设置弹层已存在，包含这些结构入口：
  - 提供商
  - 记忆
  - MCP 服务器
  - 技能
- 侧边栏收起功能已存在
- 收起/展开已有基础过渡动画

#### 本地 daemon

- Fastify daemon 已可启动
- 健康检查已通
- shell overview 数据接口已通
- 真实任务中心接口已通
- library 结构和块级读取接口已通
- 权限型 sandbox executor 已接到真实后端入口
- attention / memories / skills / providers / MCP catalog 接口已通
- `skills` catalog 已改成从项目根目录 `skills/` 读取定义

当前接口：

- `GET /health`
- `GET /api/shell/overview`
- `GET /api/attention`
- `GET /api/memories`
- `GET /api/memories/:id`
- `GET /api/skills`
- `GET /api/skills/:id`
- `POST /api/skills/:id/run`
- `GET /api/mcp/servers`
- `GET /api/mcp/servers/:id`
- `GET /api/runtime/scripts`
- `GET /api/runtime/scripts/:id`
- `POST /api/runtime/scripts/:id/run`
- `GET /api/providers`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks`
- `GET /api/artifacts`
- `GET /api/artifacts/:id`
- `GET /api/library`
- `GET /api/library/:id/structure`
- `GET /api/library/:id/blocks`
- `GET /api/library/:id/cross-references`
- `GET /api/library/search`
- `GET /api/runtime/sandbox-runs`
- `GET /api/runtime/sandbox-runs/:id`

#### SQLite 和数据预览

- SQLite 已落地
- 已有预览数据和首批表
- `task_runs` 已接到真实任务链路
- 已补 `document_structures`、`section_spans`
- `content_blocks_fts` 已接到真实 ingest 写入和检索回退

当前数据库文件：

- [apps/.data/aliceloop.db](/Users/raper/workspace/Projects/Aliceloop/apps/.data/aliceloop.db)

#### 共享类型

已定义的主对象：

- `LibraryItem`
- `StudyArtifact`
- `TaskRun`
- `AttentionState`
- `AttentionEvent`
- `MemoryNote`
- `DocumentStructure`
- `SectionSpan`
- `ContentBlock`
- `CrossReference`
- `SandboxRun`
- `SkillDefinition`
- `McpServerDefinition`

#### PDF ingest 骨架

- `packages/pdf-ingest` 已有第一版 heuristic pipeline
- 已能基于 txt / md / 标题结构抽出：
  - `DocumentStructure`
  - `SectionSpan`
  - `ContentBlock`
  - 基础 `CrossReference`
- `document-ingest` 任务已能把这些结构真实写入数据库
- 文本型资料已通过权限型 sandbox 的 `read` 原语接入 ingest

#### 权限型 sandbox executor

- 已有统一执行平面：
  - `read`
  - `write`
  - `edit`
  - `bash`
- 已有默认路径边界：
  - repo / workspace 只读
  - app data / uploads 可写
- 已有 `bash` 命令 allowlist、cwd 限制、参数路径校验、超时和执行日志
- 附件上传已通过 sandbox `write` 落盘
- `document-ingest` 已通过 sandbox `read` 读取文本型资料
- sandbox 运行日志已写入数据库并可通过 daemon API 查看

#### 核心 skeleton 任务层

- `document-ingest` 已接 managed task
- `review-coach` 已接 managed task
- `script-runner` 已接 managed task
- runtime scripts 已有受控目录和按脚本 ID 运行入口
- runtime scripts 已有目录约定文档，并能通过 skill catalog 绑定到具体脚本
- provider 回复已通过 per-session 轻量队列串行化，避免同一会话内并发乱序
- `skills` catalog 已能返回当前可用与 planned 的能力骨架
- `skills` 已有详情和最小执行入口
- `providers` list 已能返回真实 provider 配置摘要
- `attention` 和 `memories` 已有独立只读 API
- `artifacts` 已有独立只读 API
- `runtime catalog` 已有聚合只读 API，可一次返回 presence、queue、stats、providers、skills、runtime scripts、MCP 与近期 sandbox runs

### 2.2 当前可测试内容

现在可以测试的是：

- 浏览器预览桌面壳
- daemon 数据联调
- 设置弹层骨架
- 侧边栏收起/展开
- 发送框与主消息区布局
- `document-ingest` 任务创建与状态流
- library 结构、块级内容、搜索接口
- task center 的筛选和只读 API
- 权限型 sandbox executor 的后端 smoke
- attention / memories / skills / providers / MCP catalog API
- runtime catalog 聚合 API
- `script-runner` 的后端 smoke
- per-session queue 的后端 smoke

当前测试入口：

- 桌面 web 预览：`http://127.0.0.1:5173/`
- daemon 健康检查：`http://127.0.0.1:3030/health`

## 3. What Is Not Done Yet

下面这些是明确还没做完的，不要误判成“已有能力”。

### 3.1 PDF 理解与导航系统

还没完成：

- 数字型 PDF 结构提取
- outline / 目录 / 页码映射
- 图表裁切和回链
- 真正的 PDF 正文抽取
- 更强的概念级 cross reference

当前已经有第一版可跑 pipeline，但还属于 heuristic 版本，不是最终 PDF extractor。

### 3.2 Memory System 真正实现

设计已经拍板，但工程实现还没有完整落下。

还缺：

- 更完整的全文检索策略
- 更强的交叉索引抽取
- 注意力索引的事件累积与聚合
- 从 attention 到 memory 的蒸馏
- postmortem / failure memory 真正落表

### 3.3 Artifact 生成链路

还缺：

- 学习页生成器
- 专题页生成器
- 晚间复习包生成器
- artifact 模板与版本化
- artifact 与 source block 的引用关系

### 3.4 Tele / Remote Continuity

还没做：

- Telegram Bot 接入
- chat/workspace binding
- Tele 文件投递
- Tele 状态回传
- Tele 驱动本地任务

### 3.5 本地 TypeScript 脚本 runtime

现在已经明确不走 Python 依赖链，首版只保留 TypeScript / Node 脚本执行能力。

还缺：

- 脚本执行日志的前端展示

### 3.6 真正的桌面能力

还没做：

- 原生文件选择器接入
- 拖拽导入资料
- 真正的 Electron dev 启动闭环
- 原生菜单/快捷键/窗口细节

### 3.7 前端功能完整性

现在前端只是结构壳，不是完整产品。

还缺：

- 线程列表
- 消息流渲染
- artifact 页面
- 设置各页真实表单
- 记忆页真实数据视图
- skills / MCP / provider 的真实交互

## 4. Next Milestones

## Milestone A: 数据与索引落地

目标：

- 把“看起来像在工作”变成“真的有数据层”

要做：

1. 正式整理 SQLite schema
2. 补 repository 层
3. 落地这些索引：
   - FTS
   - cross index
   - attention index
   - memories
4. 把 preview seed 改成更正规的初始化逻辑

完成标准：

- 数据不再只靠预览对象
- daemon 能从数据库真实返回 library / attention / memories / task runs

当前进度：

- 这条 milestone 的主体已经基本落地
- `task_runs`、`library`、`attention`、`memories` 都能从数据库真实返回
- 还差 preview seed 的进一步收口与整理

## Milestone B: PDF 导航链路

目标：

- 让系统先会“找”，再会“总结”

要做：

1. 判断 PDF 类型
2. 提取目录和章节边界
3. 生成 `DocumentStructure / SectionSpan / ContentBlock`
4. 为块级内容建立 FTS
5. 为章节、概念、图表建立 cross reference

完成标准：

- 一份真实 PDF 能被导入
- 系统能快速定位到相关章节/页段

当前进度：

- 已完成 1, 2, 3, 4 的第一版
- 第 5 项已有基础 cross reference，但还不是最终质量
- 文本型资料已通过 sandbox 接入真实读取
- 下一步重点是把“真实 PDF 文本抽取”补上，替换现在的 heuristic 路线

## Milestone C: Artifact 生成

目标：

- 从“能找内容”升级到“能产出学习结果”

要做：

1. 学习页生成
2. 专题页生成
3. 晚间复习包生成
4. artifact source mapping

完成标准：

- 用户导入一份资料后，系统能产出至少一种可用 artifact

## Milestone D: Tele 接入

目标：

- 做到 agent continuity，而不是只停留在桌面前台

要做：

1. Telegram Bot 接入
2. allowed users
3. channel/workspace binding
4. Tele 发消息触发本地任务
5. Tele 回传任务状态和结果摘要

完成标准：

- 用户可以在 Tele 上发起一个学习任务，并看到结果回传

## Milestone E: TypeScript Script Runtime

目标：

- 复杂任务时有“工具臂”，但只依赖 Node / TypeScript

要做：

1. ts/js 脚本目录和约定
2. runtime path resolve
3. local script runner
4. 安全边界和日志

完成标准：

- 没有额外语言运行时也能跑受控脚本

## 5. Frontend Status And Rules

当前前端策略已经明确：

- 现在只做结构壳
- 不做最终视觉定稿
- 保持可优化、可替换
- 尽量贴 Alma 的信息架构，但不在此阶段精细抄完全部细节

当前前端还需要继续做的事情：

1. 收起侧边栏动效继续打磨
2. 消息流真正渲染
3. 线程列表替换 `New Chat` 占位
4. 设置页和真实数据连接
  5. artifact 页面单独做路由或视图切换

## 6. Git 纪律

从 `Aliceloop 1.0` 开始，后续 git 提交默认遵守下面这套规则。

### 6.1 提交前缀

默认采用 conventional commits 形式：

- `feat(scope): summary`
- `fix(scope): summary`
- `test(scope): summary`

当前类型只使用：

- `feat:`
- `fix:`
- `test:`

### 6.2 原子化提交

每个提交尽量只完成一个小任务。

正确例子：

- `feat: add runtime catalog stats`
- `fix: resolve live runtime script launch path`
- `test: cover session queue serialization`

避免：

- 一个提交同时混进前端布局、provider、数据库、文档四条主线
- 把多个无关功能压成一个巨大提交
- 长时间把试验性改动堆在工作区不整理

如果一轮对话里实际上解决了 3 个问题，就应该拆成 3 个**问题单元**：

- 分别实现
- 分别验证
- 必要时分别提交

不要把“一次回答”直接等同于“一次提交”。

### 6.3 推荐顺序

1. `feat:` 或 `fix:` 落真实改动
2. `test:` 补 smoke / 验证脚本
3. 必要时同步文档

scope 建议直接对应真实问题边界，例如：

- `feat(daemon): ...`
- `fix(runtime): ...`
- `test(queue): ...`
- `feat(docs): ...`

## 7. Immediate Todo

如果下一次开新对话，最推荐直接从这里往下干：

1. 把真正的 PDF 文本抽取接进 `packages/pdf-ingest`
2. 把 `DocumentStructure / SectionSpan / ContentBlock` 的质量从 heuristic 提升到真实文档级
3. 把 settings 四页继续接到这些真实后端接口
4. 补强概念级 cross reference 和 attention 聚合
5. 把 artifact source mapping 接到新结构层
6. 最后再推进 Tele continuity 和 TypeScript script runtime

这是当前最稳的顺序。

不要先做：

- Discord
- 飞书
- 通用 MCP 商店
- Provider 完整后台
- 复杂前端美化
- 大量设置页细节

## 8. Suggested Commands

当前最常用的命令：

```bash
npm run dev:web --workspace @aliceloop/desktop
npm run start --workspace @aliceloop/daemon
npm run typecheck
npm run build
```

调试用：

```bash
curl http://127.0.0.1:3030/health
curl http://127.0.0.1:3030/api/shell/overview
curl http://127.0.0.1:3030/api/attention
curl 'http://127.0.0.1:3030/api/memories?limit=20'
curl http://127.0.0.1:3030/api/memories/memory-1
curl http://127.0.0.1:3030/api/skills
curl http://127.0.0.1:3030/api/skills/script-runner
curl http://127.0.0.1:3030/api/mcp/servers
curl http://127.0.0.1:3030/api/mcp/servers/filesystem-bridge
curl http://127.0.0.1:3030/api/runtime/scripts
curl http://127.0.0.1:3030/api/runtime/scripts/runtime-overview
curl http://127.0.0.1:3030/api/providers
curl 'http://127.0.0.1:3030/api/tasks?limit=10'
curl 'http://127.0.0.1:3030/api/artifacts?limit=10'
curl 'http://127.0.0.1:3030/api/library/search?q=sandbox&limit=10'
curl 'http://127.0.0.1:3030/api/runtime/sandbox-runs?limit=20'
curl http://127.0.0.1:3030/api/runtime/sandbox-runs/<run-id>
npm run smoke:sandbox --workspace @aliceloop/daemon
npm run smoke:tasks --workspace @aliceloop/daemon
npm run smoke:tasks:api --workspace @aliceloop/daemon
```

## 8. Handoff Note

如果明天开新对话，最重要的上下文是：

- 产品方向已经定，不再讨论“是不是做 Alma/OpenClaw 克隆”
- runtime loop 的长期基线已经写入
  [AGENT_DESIGN_THINKING.md](/Users/raper/workspace/Projects/Aliceloop/AGENT_DESIGN_THINKING.md)
  的 `4.4 Runtime Loop Baseline`
- 以后涉及 agent 设计、skills、GUI 流式协议、多端同步时，必须先参考这一节
- 尤其要先看：
  - `4.4.2 四原语不变`
  - `4.4.2.1 分层拍板`
  - `4.4.8 Policy Loop 不是 Workflow`
  - `4.4.9 权限型沙箱优先`
  - `4.4.10 OpenClaw 借鉴边界`
- 记忆层已经定成四层：
  - FTS
  - cross index
  - attention index
  - memories
- 当前默认分层是：
  - `Gateway / Control Plane`
  - `Runtime Core / State Plane`
  - `Execution Plane / Sandbox`
  - `Skills`
  - `Agent Loop`
- 这里的 `Agent Loop` 还是目标层，不要误判成已经实现完成
- 当前首版沙箱策略已经拍板：
  - 先做权限型沙箱
  - 当前已落成第一版 sandbox executor
  - 不先做 Docker-first
  - 不允许把 policy loop 写回固定 workflow
- 当前最缺的不是前端，而是：
  - 正式 schema
  - PDF 导航链路
  - artifact 生成链路
  - Tele continuity
  - TypeScript script runtime

因此，新的对话应该优先围绕：

**“把文档结构和索引层真正做出来”**

而不是继续在 UI 细节里打转。
