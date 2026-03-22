# Sandbox Decisions

## Date

2026-03-19

## Context

Aliceloop 当前没有引入 Docker、VM、gVisor、seccomp 或其他系统级隔离后端。

因此，这一轮沙箱设计的目标不是“内核隔离级沙箱”，而是把**宿主机策略层沙箱**做诚实、做清楚、做可审计：

- 明确哪些动作默认允许
- 明确哪些动作需要单次提权
- 明确哪些动作属于完全访问权限
- 明确用户当前看到的是**有效权限**

产品语义上，Aliceloop 目前应当被描述为 **host-guarded execution**，而不是 system sandbox。

## Final Decisions

### 0. Agent ABI 固定为六原子操作，这是硬约束

从现在开始，Aliceloop 的 agent loop 底层执行 ABI 固定为六个原子命令：

1. `read`
2. `grep`
3. `glob`
4. `write`
5. `edit`
6. `bash`

这条约束是**架构级硬约束**，不是“当前实现偏好”。

之所以从四原子扩成六原子，是为了增强稳定性：把高频、稳定、可预测的检索动作显式固定为 `grep` 和 `glob`，避免让它们在 `bash` 里漂移成不可控的临时实现。

以后不得再随意往 agent loop 里新增新的底层执行 tool，不得再把某个高层能力直接做成新的 sandbox primitive。

明确禁止的错误方向包括：

- 为删除单独新增一个底层 `delete` primitive
- 为 web search 单独新增一个底层 `websearch` primitive
- 为 fetch / browser / skill-discovery / send-file / review 之类高层能力继续扩展新的原生 agent-loop tool
- 为模型开放“注册新工具”入口，允许它动态改写系统工具面

高层能力的正确实现方式固定为：

- **底层只保证六原子命令**
- **agent 的其他能力通过 skills 组织**
- **skills 通过编排现有底层原子操作完成任务**

同时，允许的一条实现路径也应当明确固定：

- **模型可以在沙箱里通过 `write` / `edit` 生成临时 helper 文件或脚本**
- **模型可以通过 `bash` 执行这些临时 helper**
- **helper 用完即弃，必要时由模型自行清理**
- **这类 helper 只是六原子组合下的一次性实现细节，不是一等能力**
- **helper 不进入 tool registry，不改变系统工具面**

例子：

- `web-search` 是一个 skill。它可以依赖底层 `bash`，也可以声明自己会用 `WebSearch` / `WebFetch` 这类 skill 级能力，但这不意味着要把它们变成新的底层 sandbox primitive。
- `twitter-media` 或 `video-analysis` 这类 skill。它们的能力应当建立在 `read`、`grep`、`glob`、`write`、`edit`、`bash` 这些底层原子命令之上，再组合其他 skill，而不是继续往 agent loop 底层塞新的 native tool。

因此，架构分层必须固定为：

- 底层执行 ABI：`read` / `grep` / `glob` / `write` / `edit` / `bash`
- 上层能力表达：`skills`
- 复杂任务能力：通过多个底层原子操作 + skill 组合实现

以后如果需要新增能力，默认路径必须是：

1. 先判断能不能用六原子命令表达
2. 如果是高层任务能力，先做成 skill
3. 如果只是局部自动化 glue，允许生成临时 helper 脚本，但它仍然只是六原子组合，不算新增 tool
4. 只有用户明确批准并重新做架构决策时，才允许讨论是否修改底层 ABI

默认结论不是“加 tool”，而是“先用六原子命令 + skill 组合解决”。

### 1. 分层结构固定为四层

当前沙箱实现按以下层次组织：

1. `Tool Policy`
2. `Runtime Policy`
3. `Sandbox Runtime`
4. `UX + Audit`

当前 `Runtime Policy` 只选择 `host runtime`，但结构已经预留给未来更多 backend。

这次决策的重点不是马上接容器，而是先把宿主机权限语义纠正干净。

### 2. Profile 只保留两档

沙箱 profile 只保留：

- `development`
- `full-access`

不再把 `elevated` 当作第三个常驻 profile。

对应产品文案：

- `development` = 开发模式
- `full-access` = 完全访问权限

### 3. `elevated` 不是模式，而是单次动作级破例

执行访问级别只保留：

- `standard`
- `elevated`

语义固定如下：

- `elevated` 只属于 `development`
- `elevated` 只对**单次动作**生效
- 动作执行完后，会话仍然回到 `development`
- 所有 `elevated` 动作都必须显式审批
- 审计日志必须明确标记为 `elevated`

这意味着：

- 开发模式是日常默认路径
- 少量越界动作可以通过单次 `elevated` 放行
- 完全访问权限不是 `elevated` 的别名，而是另一种会话级 profile

### 4. 开发模式的默认能力边界

开发模式的默认边界固定为：

- `read`: 默认只允许读取项目根目录、daemon data 目录、uploads 目录，以及显式挂入的额外 read roots
- `write`: 默认只允许写入项目根目录、daemon data 目录、uploads 目录，以及显式追加的额外白名单目录
- `edit`: 同时受 `read + write` 约束，只有文件位于当前可读且可写 roots 内才能直接编辑
- `bash cwd`: 默认只允许在项目根目录、daemon data 目录、uploads 目录，以及显式追加的额外 cwd 白名单中执行

开发模式下的 `bash` 还要同时满足：

- 命令必须在 allowlist 内
- 参数中的路径必须继续受读写边界约束
- 危险表达式必须显式拒绝
- 标准 `bash` 执行仍需要审批

当前 allowlist 命令为：

- `cat`
- `find`
- `git`
- `head`
- `ls`
- `node`
- `npm`
- `pwd`
- `rg`
- `sed`
- `tsx`
- `wc`

当前额外限制包括：

- `find` 禁止 `-exec` / `-execdir` / `-ok` / `-okdir`
- `npm` 只允许开发模式白名单子命令

### 5. 开发模式下的单次 `elevated` 规则

当开发模式中的动作超出默认策略时：

- `read`
- `write`
- `edit`
- `bash` 中与读写路径、执行路径、命令白名单相关的越界动作

都可以申请一次 `elevated` 审批。

审批通过后：

- 只放行这一次动作
- 不把会话切换成 `full-access`
- 审计里记为 `[elevated]`

如果没有配置 `requestElevatedApproval` hook，则这些越界动作必须直接阻断，不能偷偷执行。

备注：

- `read` 越界可以走单次 `elevated`，也可以通过显式挂入新的 read root 解决
- `bash` 的只读路径越界也可以走单次 `elevated`
- `bash` 的 `cwd` 越界当前仍然不走 `elevated`，而是要求先挂入对应目录

### 6. 完全访问权限的真实含义

`full-access` 的语义固定为：

**宿主机当前用户级的宽松访问，不是 root，不是 sudo，也不是系统级绕过。**

它当前的执行特征是：

- 跳过路径限制
- 跳过命令 allowlist
- 跳过参数路径检查
- 仍然通过 `host runtime` 执行
- 仍然保留审计
- 仍然可以保留 `bash` 审批 hook

因此，完全访问权限应该被描述为：

> 宿主机当前用户级完全访问

而不应该被描述为：

> 整台电脑所有权限

### 7. 审计规则固定保留

所有 sandbox 动作都必须进入 `sandbox_runs`。

审计 detail 必须带访问级别标签：

- `[standard]`
- `[elevated]`

结果语义固定为：

- 正常完成：`done`
- 用户拒绝审批 / 违反策略：`blocked`
- 其他异常：`failed`

### 8. 中断恢复也属于沙箱策略的一部分

由于工具审批当前依赖内存 broker，而 session/event/sandbox run 又是持久化真相层，因此 daemon 重启后必须做恢复收口。

启动时固定执行以下恢复：

- 把仍处于 `running` 的 `provider-completion` job 改成 `failed`
- 把失去 broker 上下文的 pending tool approvals 改成 `rejected`
- 把仍处于 `running` 的 `sandbox_runs` 改成 `failed`

目的不是“继续旧动作”，而是避免出现：

- UI 还显示正在运行
- 实际 agent 已经不存在
- 待审批状态丢失

### 9. UX 文案必须服从真实能力

以后所有 UI/文档都必须遵守以下表达：

- 开发模式：默认受限，但支持少量单次 `elevated`
- 完全访问权限：宿主机当前用户级宽松执行
- `elevated`：只属于开发模式里的单次动作，不是第三个会话模式

不得再出现“看起来有权限，实际上做不了”的假语义。

### 10. Future Agent Design Rule

未来所有 agent 设计都必须继承本页的第 `0` 条决策：

- 不得膨胀底层原子工具集合
- 不得把高层能力直接下沉成新的 agent-loop primitive
- 不得开放模型注册新工具或改写系统工具面
- 新功能默认优先落到 `skills`
- skill 的实现优先复用六原子命令，而不是扩增底层 ABI
- 允许模型在沙箱里写临时 helper 文件 / 脚本并通过 `bash` 使用，但它们必须保持一次性、不可注册、不可产品化暴露

未来 agent 的底层默认集合固定为：

- `read`
- `grep`
- `glob`
- `write`
- `edit`
- `bash`

如果后续实现与这条原则冲突，应当默认认为实现方向错了，而不是默认继续加 tool。

## Non-Goals

本轮决策**没有**承诺以下能力：

- Docker 容器隔离
- Linux namespace / cgroup / seccomp / AppArmor
- gVisor / Firecracker / microVM
- 真正的内核级沙箱

如果未来接入新的 runtime backend，它应当被看作当前架构的增强，而不是当前宿主机策略层的替代定义。

## Practical Consequences

这次策略落地后的产品结论是：

- Aliceloop 现在是一个诚实的宿主机策略层沙箱
- 开发模式适合日常开发，默认只读工作区/data/uploads，工作区外目录必须显式挂入后才能读取
- 少量越界动作通过单次 `elevated` 放行，而不是一刀切切到高权限
- 完全访问权限适合你明确想让 agent 以宿主机当前用户宽松执行的场景
- 真隔离以后可以继续做，但不再和当前 host policy 语义混在一起
