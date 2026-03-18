# Aliceloop Agent Design Thinking

这份文档是 Aliceloop 的长期决策基线。

它的作用不是描述某一个功能，而是把以后做 agent 时最重要的判断顺序固定下来：

`场景 -> 逻辑决策 -> 实现功能`

如果后续出现新想法、新技术或新灵感，先回到这份文档判断它属于哪一层、解决什么问题、是不是当前主路径，再决定要不要实现。

## 1. 我们到底在做什么

Aliceloop 不是通用 Alma 克隆，也不是单纯的聊天壳。

它是一个：

- 桌面本体优先的本地 AI runtime
- 可跨多个 surface 持续存在的 companion
- 面向文档、任务、本机动作和工件生成的长期工作台

首版核心闭环：

1. 导入本地 PDF、网页、文本或附件
2. 快速定位相关结构、内容块、上下文和操作目标
3. 生成可回看 artifact 或执行本机动作
4. 让用户感觉 agent 一直知道最近的上下文、状态和任务进度

## 2. 四条推的精华

### 2.1 widgetReadme

精华不是“回答更漂亮”，而是：

**输出从文本升级为 artifact。**

启发：

- LLM 不只是生成 answer，也可以生成可操作工件
- 我们的主输出不该被“知识卡片”绑死
- 更自然的输出是：
  - 结构化页面
  - 主题页
  - 会话摘要
  - 关系索引页

### 2.2 OpenClaw / continuity

精华不是“支持某个消息渠道”，而是：

**agent 脱离桌面前台后仍然连续存在。**

启发：

- GUI 是本体，但 remote / companion surface 是连续控制面
- 用户离开电脑之后，任务、上下文和状态不该断掉
- 外部 surface 不只是一个设置页里的渠道，而是系统连续性的一部分

### 2.3 四工具 / shell debate

精华不是“工具越少越酷”，而是：

**agent runtime 的最小原语应该尽量小而稳。**

结论：

- 核心 loop 先只保留稳定原语：
  - `read`
  - `write`
  - `edit`
  - `bash`
- 复杂能力尽量放到 skill / 模块
- 真正困难的任务允许落到受控的 TypeScript / Node 脚本

### 2.4 Postmortem

精华不是“写复盘很传统”，而是：

**把失败经验变成工程记忆。**

这里的原始语义优先是：

- 工程 postmortem
- 运行失败记忆
- 避免修了 A 又炸 B / C

后续可以扩展成学习场景里的失败记忆，但第一定义不是用户记忆，而是系统自我迭代记忆。

## 3. 五层框架

以后每个新点子都先判断它落在哪一层。

### 3.1 Surface

用户从哪里和系统交互。

- 桌面 GUI
- companion surface
- 以后如果有 Discord 或别的入口，也在这一层

问题示例：

- 这个功能应该在桌面展示，还是在 companion 里展示
- 这是主入口，还是附属通道

### 3.2 Runtime

系统如何持续运行、编排任务和调用能力。

- session
- queue
- worker
- 本地工具调用
- 本地脚本 runtime

问题示例：

- 这个功能是内核原语，还是上层 skill
- 这个任务应该串行跑还是可并行

### 3.3 Skills

面向具体场景的局部操作协议，而不是功能商店。

首批只做产品能力型 skills：

- `document-ingest`
- `study-artifact`
- `review-coach`
- `script-runner`

问题示例：

- 这是不是应该抽成一个独立策略模块
- 这部分逻辑是否会污染主 prompt

### 3.4 Artifacts

任务产出物的形态。

我们不默认产出“卡片”，而是按任务选择最合适的 artifact：

- 结构化页面
- 主题页
- 会话摘要
- 关系索引页

问题示例：

- 这次任务的最佳输出是什么
- 用户最终回看的到底是什么

### 3.5 Memory / Governance

系统如何记住重要东西，以及如何避免不断重复犯错。

- 全文检索
- 交叉索引
- 注意力索引
- 高层记忆
- 工程 postmortem

问题示例：

- 这是“热记忆”还是“冷记忆”
- 这是检索加速，还是长期沉淀结论

## 4. 场景 -> 逻辑决策 -> 实现功能

新需求不要直接翻译成功能清单，先走这一套。

### 4.1 场景

用户现在在做什么？

例子：

- “我想快速回到昨天看的那份文档”
- “帮我找这个项目里和运行时队列相关的实现和接口”
- “把今天处理的内容整理成一个可回看的结果页”

### 4.2 逻辑决策

系统先判断：

1. 这是定位问题、理解问题，还是产出问题
2. 应该先走结构导航、全文检索，还是注意力索引
3. 这次应该产出哪种 artifact
4. 这条行为是否值得进入长期记忆

### 4.3 实现功能

最后才决定要做什么：

- 新 skill
- 新索引
- 新 artifact 模板
- 新 GUI 视图
- 新 runtime 行为

### 4.4 Runtime Loop Baseline

以后凡是讨论 Aliceloop 的 agent loop、runtime、技能边界或多端同步，都必须先参考这一节。

这次拍板的核心不是：

- 把系统写成固定 workflow
- 工程代码先分流成 `action mode` / `artifact mode`
- 把 GUI 协议绑死成“聊天文本流”

而是：

**Aliceloop 是一个 stateful policy loop，不是一个硬编码 workflow engine。**

#### 4.4.1 统一判断

模型面对的是统一状态，而不是工程师预先切好的流程分支。

统一状态至少包括：

- 当前 session
- 近期消息
- attention state
- memory
- attachments
- jobs
- artifacts
- 当前桌面 / runtime 上下文

模型在同一个 loop 里自主决定“下一跳操作”。

#### 4.4.2 四原语不变

runtime 的最小执行原语仍然固定为：

- `read`
- `write`
- `edit`
- `bash`

这里必须特别分清：

- 这四个原语是 **execution ABI / sandbox ABI**
- 它们不是 runtime core 的全部

runtime core 负责的是：

- session
- queue
- events
- jobs
- memory
- artifacts
- persistence

不要因为要做电脑控制、artifact、远程同步，就把执行平面重新膨胀成一堆杂乱工具。

复杂能力仍然上移到 skill：

- `desktop-control`
- `document-ingest`
- `study-artifact`
- `widget-skill`
- `review-coach`

skill 内部再用四原语完成工作。

#### 4.4.2.1 分层拍板

以后讨论 Aliceloop 架构时，默认按这五层理解，不要混用概念：

1. `Gateway / Control Plane`
   - 消息入口
   - heartbeat
   - surface binding
   - snapshot / stream
2. `Runtime Core / State Plane`
   - session
   - queue
   - events
   - jobs
   - memory
   - artifact
3. `Execution Plane / Sandbox`
   - `read`
   - `write`
   - `edit`
   - `bash`
4. `Skills`
   - `document-ingest`
   - `study-artifact`
   - `review-coach`
   - `desktop-control`
5. `Agent Loop`
   - observe
   - decide next operation
   - call skill / primitive
   - emit typed commits

因此：

- heartbeat 和消息接入属于第一层
- session / memory / artifact / queue 属于第二层
- 四原语属于第三层
- skill 是第四层
- loop 是第五层

沙箱不是整个 runtime，也不是整个 loop。

更准确地说：

**沙箱是 agent loop 的执行平面。**

#### 4.4.3 电脑控制权不能丢

Aliceloop 不是“上传资料 -> 返回工件”的普通聊天软件。

它必须保留桌面宿主的执行权：

- 打开和定位本地资料
- 打开和定位本地资源
- 调本地脚本
- 调浏览器或桌面自动化
- 触发后台任务
- 生成并更新 artifact

因此“行动”和“生成工件”不是互斥路线，而是同一个 policy loop 中都可被选择的操作。

#### 4.4.4 Artifact 不是默认输出

artifact 很重要，但不是每轮都必须产出。

更准确的原则是：

- 简单问答可以只回复消息
- 需要操作电脑时可以先行动
- 需要沉淀成可回看资产时才调用 `widget-skill`
- 一轮里允许同时：
  - 先行动
  - 再产出 artifact
  - 再补一条解释消息

也就是说，artifact 是按需选择的操作，不是默认模板。

#### 4.4.5 GUI 必须吃“typed commits”，不是只吃文本流

如果协议只支持 assistant 文本流，Aliceloop 会退化成聊天软件。

GUI 和多端同步必须原生支持结构化提交，例如：

- `message.emit`
- `skill.call`
- `desktop.act`
- `artifact.begin`
- `artifact.patch`
- `artifact.done`
- `job.update`
- `memory.upsert`
- `finish`

这意味着：

- 传输层可以是 HTTP + SSE，也可以以后接 WebSocket
- 但语义必须是事件流 / commit stream
- 不能把协议设计成“只有 message delta”

#### 4.4.6 Runtime 和前端的职责边界

模型不直接操纵前端组件，也不直接写 UI 代码。

正确边界是：

1. 模型决定下一步操作
2. skill 产出结构化 op / commit
3. runtime 校验并持久化
4. GUI 根据 commit 渲染消息、动作状态和 artifact

`widget-skill` 的职责是生成受控的 artifact schema / block tree / patch ops，不是直接生成随意的前端实现。

#### 4.4.7 推荐 loop 形态

推荐的内核心智模型是：

`observe -> decide next operation -> execute bounded skill loop -> emit typed commits -> persist -> publish -> reflect`

其中：

- 决策在模型
- 约束在 runtime
- 长期状态在 session / memory / artifact store
- 四原语只存在于执行层

这个 loop 可以产生：

- 普通消息
- 本机动作
- artifact 变更
- 后台 job
- 记忆更新

而不是只产出一段文本。

#### 4.4.8 Policy Loop 不是 Workflow

`policy loop` 这个词容易让人误会成流程编排，这里要明确拍板：

- 不是工程师先写好 `if/else` 路线图
- 不是先把请求切成 `action mode` / `artifact mode`
- 不是 BPMN / DAG / 节点图先行

更准确的意思是：

- 模型面对统一状态
- 模型自己决定下一跳操作
- runtime 只提供约束、持久化和提交边界

因此 Aliceloop 要避免：

- 先写死“什么时候一定走 artifact”
- 先写死“什么时候一定走 action”
- 先把 agent loop 做成一套工程化审批流

允许存在的只有：

- 安全边界
- 幂等边界
- session 串行边界
- commit schema

除此之外，下一步动作尽量由模型决定。

#### 4.4.9 权限型沙箱优先

首版沙箱先不走 Docker-first，也不追求 microVM。

首版优先做 **权限型沙箱**：

- 对工作目录做路径限制
- 对 `read/write/edit` 做 allowlist 校验
- 对 `bash` 做命令前缀、工作目录、超时和日志约束
- 对高风险操作做审批或显式开关

这样做的原因：

- Aliceloop 当前是桌面本体优先产品
- 我们先要稳定执行 ABI，而不是先追求重隔离
- 权限型沙箱更容易和 Electron / daemon / 本地会话状态整合

以后如果要给陌生代码更强隔离，再把第三层替换成 Docker 或更强沙箱实现。

#### 4.4.10 OpenClaw 借鉴边界

OpenClaw 值得借鉴的是：

- 单一 gateway / host process
- per-session serialized runs
- event stream
- skills / tools / sandbox 分层

但 Aliceloop 不照抄这些部分：

- text-first output shaping
- 多渠道优先的产品形态
- 把聊天回复当成默认主产物

对 Aliceloop 来说，更适合的是：

- 借它的外层 orchestration
- 不借它的 text/tool-first output assumption

也就是说：

**借骨架，不借产品默认语义。**

## 5. 为什么只选 TypeScript

主语言选 TypeScript，不走 Python 工具臂。

原因：

- Electron 桌面产品壳最自然
- 会话、流式状态、runtime 编排在 Node/TypeScript 里更顺
- 技术栈统一，便于做本地 daemon、桥接和工具注册
- 本地脚本也可以统一走 TypeScript / Node，不必再引入另一套运行时和分发复杂度

这意味着：

- **TS 既是主脑，也是第一版工具臂**

## 6. 为什么不用“卡片产品”做真相层

“知识卡片”可以是一个视图，但不应该是真相层。

原因：

- 复杂文档的颗粒度复杂，正文、图像、目录、附件、关系并不统一
- 卡片对交叉关系和上下文保真度不够
- 一旦数据库从一开始按 card-first 设计，后面所有东西都会被卡片绑架

因此首版真相层应该是：

- 文件层：
  - 原始 PDF
  - 分片文档
  - 页级图像
  - 必要的资源裁切
- 对象层：
  - 文档结构
  - 结构片段
  - 内容块
  - 交叉引用

卡片如果以后存在，也只是派生视图，不是主存储对象。

## 7. Git 与发布纪律

从 `Aliceloop 1.0` 开始，工程推进默认遵守这套提交纪律。

### 7.1 版本含义

`Aliceloop 1.0` 表示第一版 runtime skeleton 已经成立：

- daemon / gateway 已经存在
- runtime core 已经有真实状态层
- permission sandbox 已经有统一执行 ABI
- provider / tasks / runtime catalog 已经能走真实链路

它不表示所有长期目标都已完成，而表示骨架已经足够稳定，可以承接后续连续演进。

### 7.2 提交前缀

后续默认采用 conventional commits 形式：

- `feat(scope): summary`
- `fix(scope): summary`
- `test(scope): summary`

当前类型先只使用：

- `feat:`
- `fix:`
- `test:`

### 7.3 原子化原则

每次提交尽量只表达一个最小意图：

- 一个小功能
- 一个明确 bugfix
- 一组与该功能直接相关的测试

不要把多条无关主线揉进同一个提交。

如果一轮对话里实际上解决了 3 个问题，就应该拆成 3 个**问题单元**：

- 分别实现
- 分别验证
- 必要时分别提交

不要把“一次回答”直接等同于“一次提交”。

### 7.4 对本项目的具体要求

- runtime / daemon / 前端布局，尽量分开提交
- 先落真实链路，再补测试和文档
- 临时实验不要长时间滞留在主分支工作区
- `1.0.x` 阶段优先沿现有 skeleton 收口，不再重写分层

scope 建议直接对应真实问题边界，例如：

- `feat(daemon): ...`
- `fix(runtime): ...`
- `test(queue): ...`
- `feat(docs): ...`

## 8. PDF 导航系统原则

主流程不是：

`OCR -> 全文 -> 卡片`

而是：

`结构识别 -> 导航 -> 局部理解 -> artifact`

### 8.1 结构优先

优先提取：

- outline / bookmarks
- 目录页
- 章节标题
- 页码映射

### 8.2 导航优先

AI 不先全局搜，而是：

1. 先判定文档
2. 再判定主题
3. 再判定片段 / 页段
4. 需要时扩展到图像、附录、邻近页

### 8.3 扫描件策略

- 扫描件优先用云端视觉模型
- 本地 OCR 不是主流程
- 图像和正文允许走不同理解路径

## 9. 记忆层拍板

记忆层正式固定为四层，不再继续发散。

### 9.1 全文检索层

作用：

- 快速缩小候选范围
- 块级文本召回

实现思路：

- 参考 Alma 的 `messages_fts`
- 用 SQLite FTS5 建立块级全文索引

注意：

- 它只负责快搜
- 不承载长期注意力

### 9.2 交叉索引层

作用：

- 把概念、实体、图像、结构片段、正文连起来
- 解决纯树状目录会漏的问题

这层是知识导航，不是记忆摘要。

### 9.3 注意力索引层

作用：

- 记录用户最近在看哪些文档、哪些片段、哪些概念
- 记录最近引用过哪些内容块、图像、主题页
- 形成“系统一直在关注这件事”的直接体验

这是**热记忆**。

### 9.4 高层记忆层

作用：

- 从注意力和行为中蒸馏出长期重要结论
- 记录稳定关注主题、常见混淆点、近期处理重心

这是**冷记忆**。

### 9.5 Postmortem

优先定义为：

- 工程失败记忆
- 运行失败记忆

以后才扩展到：

- 任务失败记忆
- 用户误判记忆

## 10. Prompt Caching

Prompt caching 不是长期记忆，而是：

**把稳定不变的 prompt 前缀缓存起来，减少重复输入成本和延迟。**

它为什么重要：

- 核心 loop 越稳定，缓存越容易命中
- 工具和系统提示越少变，成本越可控
- skill 按需加载，比把所有能力都塞进主 prompt 更适合做缓存

这也是“小核心 + skills”设计的一个实际收益。

## 11. 做与不做

### 11.1 当前该做

- 桌面本体
- companion / remote continuity
- 本地 runtime
- PDF 结构导航
- FTS + 交叉索引 + 注意力索引 + 高层记忆
- 结构化页面 / 主题页 / 会话摘要

### 11.2 当前不做

- 通用 skill 商店
- 通用 MCP 市场
- 一开始就做全能 Alma 克隆
- 把所有资料都走 OCR
- 把所有真相压成一个总 JSON

## 12. 快速决策清单

新需求进来时，先问：

1. 它属于哪一层：Surface、Runtime、Skills、Artifacts、Memory/Governance
2. 它解决的是定位、理解、产出，还是记忆问题
3. 它是用户主路径，还是平台能力冲动
4. 它应该进入热记忆、冷记忆，还是只作为检索索引
5. 它是不是会把真相层重新绑回卡片或大 JSON
6. 它是不是在偷偷把 agent 再写回工程 workflow，而不是保持 policy loop
7. 它是不是把 GUI 协议重新退化成只会流式吐文本

如果这些问题答不清，就先不做。
