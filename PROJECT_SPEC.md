# Aliceloop Project Spec

这份文档是 Aliceloop 当前阶段的执行型 spec。

它和 [AGENT_DESIGN_THINKING.md](/Users/raper/workspace/Projects/Aliceloop/AGENT_DESIGN_THINKING.md) 的区别是：

- `AGENT_DESIGN_THINKING.md` 负责长期设计原则
- `PROJECT_SPEC.md` 负责当前项目到底做到了哪里、还差什么、下一步怎么接着干

## 1. Product Scope

### 1.1 产品定义

Aliceloop 是一个：

- 桌面本体优先的本地 AI companion
- 可被 Tele 连续控制的 agent runtime
- 面向中医学习场景的资料理解、定位、组织与陪练系统

### 1.2 第一阶段目标

首版不是通用 Alma 克隆，不是 MCP 市场，不是 coding agent 产品。

首版只做这条主链路：

1. 导入医学 PDF / 网页资料
2. 快速定位相关章节、页段、图表
3. 生成学习型 artifact
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

当前接口：

- `GET /health`
- `GET /api/shell/overview`

#### SQLite 和数据预览

- SQLite 已落地
- 已有预览数据和首批表
- 已包含 FTS5 检索表的雏形

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

#### PDF ingest 骨架

- `packages/pdf-ingest` 已有接口和占位 pipeline
- 但还只是结构草案，不是可用提取器

### 2.2 当前可测试内容

现在可以测试的是：

- 浏览器预览桌面壳
- daemon 数据联调
- 设置弹层骨架
- 侧边栏收起/展开
- 发送框与主消息区布局

当前测试入口：

- 桌面 web 预览：`http://127.0.0.1:5173/`
- daemon 健康检查：`http://127.0.0.1:3030/health`

## 3. What Is Not Done Yet

下面这些是明确还没做完的，不要误判成“已有能力”。

### 3.1 PDF 理解与导航系统

还没完成：

- 数字型 PDF 结构提取
- outline / 目录 / 页码映射
- 章节拆分
- 图表裁切和回链
- 文档结构对象落库
- 文档导航链路

当前只是有 `pdf-ingest` 包的骨架，没有真 pipeline。

### 3.2 Memory System 真正实现

设计已经拍板，但工程实现还没有完整落下。

还缺：

- 全文检索层正式 schema
- 交叉索引表和写入逻辑
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

### 3.5 托管 Python runtime

设计已经定了，但还没真正实现：

- 应用托管 Python runtime
- runtime 下载/解压/定位逻辑
- 受控目录执行脚本
- 脚本执行日志
- 本地脚本 runner 模块

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

- 一份真实医学 PDF 能被导入
- 系统能快速定位到相关章节/页段

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

## Milestone E: Python Runtime

目标：

- 复杂任务时有“工具臂”，但不要求用户机器预装 Python

要做：

1. 托管 Python runtime
2. runtime path resolve
3. local script runner
4. 安全边界和日志

完成标准：

- 没有系统 Python 的机器也能跑受控脚本

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

## 6. Immediate Todo

如果下一次开新对话，最推荐直接从这里往下干：

1. 先整理 daemon 的正式 SQLite schema
2. 然后实现 PDF 文档结构提取的第一版
3. 然后把文档结构写入数据库
4. 再补 FTS + cross index + attention index
5. 最后才接 artifact 生成

这是当前最稳的顺序。

不要先做：

- Discord
- 飞书
- 通用 MCP 商店
- Provider 完整后台
- 复杂前端美化
- 大量设置页细节

## 7. Suggested Commands

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
```

## 8. Handoff Note

如果明天开新对话，最重要的上下文是：

- 产品方向已经定，不再讨论“是不是做 Alma/OpenClaw 克隆”
- runtime loop 的长期基线已经写入
  [AGENT_DESIGN_THINKING.md](/Users/raper/workspace/Projects/Aliceloop/AGENT_DESIGN_THINKING.md)
  的 `4.4 Runtime Loop Baseline`
- 以后涉及 agent 设计、skills、GUI 流式协议、多端同步时，必须先参考这一节
- 记忆层已经定成四层：
  - FTS
  - cross index
  - attention index
  - memories
- 当前最缺的不是前端，而是：
  - 正式 schema
  - PDF 导航链路
  - artifact 生成链路
  - Tele continuity
  - 托管 Python runtime

因此，新的对话应该优先围绕：

**“把文档结构和索引层真正做出来”**

而不是继续在 UI 细节里打转。
