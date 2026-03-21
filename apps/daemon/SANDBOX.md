# Aliceloop 沙箱安全架构

## 概述

Aliceloop 采用**纵深防御（Defense in Depth）**策略，通过五个安全层次对 AI 代理的文件系统访问、命令执行和网络通信进行隔离控制。每一层独立生效，即使某一层被绕过，其他层仍然能提供保护。

## 架构总览

```
用户请求
  │
  ▼
┌─────────────────────────────────────────────────┐
│  ① 策略层 (toolPolicy.ts)                       │  应用层路径/命令白名单
│     路径检查 · 命令白名单 · 参数深度检查           │
├─────────────────────────────────────────────────┤
│  ② 身份层 (hostRuntime.ts / withPolicyFallback)  │  逐次授权 · 指纹去重
│     Elevated Approval · Bash Approval            │
├─────────────────────────────────────────────────┤
│  ③ 资源层 (sessionGeneratedFileRepository.ts)    │  文件溯源 · 删除保护
│     文件归属追踪 · 附件动态授权                    │
├─────────────────────────────────────────────────┤
│  ④ 内核层 (seatbelt.ts)                         │  macOS sandbox-exec
│     网络封锁 · 文件写入限制 · 敏感目录保护          │
├─────────────────────────────────────────────────┤
│  ⑤ 审计层 (audit.ts + sandboxRunRepository.ts)   │  全量日志 · 持久化
│     每次操作记录 status: done/blocked/failed       │
└─────────────────────────────────────────────────┘
  │
  ▼
实际 OS 执行
```

## 项目目录结构

```
apps/daemon/
├── src/
│   ├── runtime/sandbox/                    # 沙箱核心
│   │   ├── types.ts                        # 所有类型定义和接口契约
│   │   ├── toolPolicy.ts                   # ① 策略层：路径/命令/参数检查
│   │   ├── runtimePolicy.ts                # 运行时选择策略
│   │   ├── runtimeBroker.ts                # 运行时后端调度器
│   │   ├── seatbelt.ts                     # ④ 内核层：macOS Seatbelt profile 生成
│   │   ├── audit.ts                        # ⑤ 审计层：操作日志包装器
│   │   └── runtimes/
│   │       └── hostRuntime.ts              # ② 身份层：策略执行 + 审批流程 + Seatbelt 集成
│   ├── repositories/
│   │   ├── sandboxRunRepository.ts         # ⑤ 审计层：持久化存储 (SQLite)
│   │   ├── sessionRepository.ts            # ③ 资源层：附件→沙箱根路径映射
│   │   └── sessionGeneratedFileRepository.ts # ③ 资源层：文件溯源追踪
│   └── services/
│       └── sandboxExecutor.ts              # 入口：组装所有层，暴露 PermissionSandboxExecutor
├── scripts/
│   └── sandboxSmoke.ts                     # 集成测试（含 Seatbelt 测试）
```

## 各层详解

---

### ① 策略层 — `toolPolicy.ts`

**职责**：应用层的第一道门卫，在任何操作执行前进行路径和命令检查。

**核心机制**：

| 检查项 | 函数 | 说明 |
|--------|------|------|
| 读路径 | `assertReadable()` | 检查文件路径是否在 `allowedReadRoots` 内 |
| 写路径 | `assertWritable()` | 检查文件路径是否在 `allowedWriteRoots` 内 |
| 工作目录 | `assertCwd()` | 检查 bash 的 cwd 是否在 `allowedCwdRoots` 内 |
| 命令白名单 | `assertCommand()` | 只允许预定义命令，禁止绝对路径二进制 |
| 参数深检 | `assertCommandArguments()` | 按命令语义检查参数路径和危险选项 |

**参数深度检查示例**：
- `find`：阻止 `-exec`, `-execdir`, `-ok`, `-okdir`
- `rm`/`rmdir`：阻止 `-r`, `-R`, `-rf` 等递归删除
- `npm`：只允许 `install`, `run`, `test` 等安全子命令
- `sed -i`：检查目标文件的写权限
- `cat`, `head`：检查目标文件的读权限

**权限配置 Profile**：

| Profile | 路径限制 | 命令限制 | Elevated Fallback |
|---------|----------|----------|-------------------|
| `development` | 项目/data/uploads + 额外指定 | 白名单 14 条 | 支持逐次授权 |
| `full-access` | 无限制 (null) | 无限制 | 不需要 |

**默认白名单命令**：`cat`, `find`, `git`, `head`, `ls`, `node`, `npm`, `pwd`, `rg`, `rm`, `rmdir`, `sed`, `tsx`, `wc`

**路径安全**：`resolveRealPath()` 解析符号链接后检查，防止 symlink 逃逸。

---

### ② 身份层 — `hostRuntime.ts` (`withPolicyFallback`)

**职责**：在策略检查失败时，提供受控的权限升级通道，而非简单拒绝。

**核心流程**：

```
preflight() 策略检查
  │
  ├─ 通过 → standard access → 执行 → 审计
  │
  └─ 失败 (SandboxViolationError)
       │
       ├─ development 模式 + 有 requestElevatedApproval
       │   → 请求用户逐次确认 → elevated access → 执行 → 审计
       │
       └─ 其他情况
           → 记录 blocked → 抛出错误
```

**关键安全特性**：
- **逐次授权**：每次 elevated 操作独立请求用户确认，不会批量放行
- **指纹去重**：同一 run 内相同命令+参数+cwd 的重复审批请求会被抑制，防止循环
- **不可升级的操作**：`invalid command` 和 `cwd outside allowed roots` 错误不允许 elevated fallback
- **Bash 审批**：即使命令通过策略检查，`requestBashApproval` 回调仍可在执行前拦截

**环境隔离**：子进程的环境变量被裁剪到最小集合：
`ALICELOOP_DATA_DIR`, `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `USER`

---

### ③ 资源层 — 文件溯源与动态授权

**职责**：追踪 AI 创建的文件，控制删除权限；将用户附件动态映射为沙箱根路径。

#### 文件溯源 (`sessionGeneratedFileRepository.ts`)

```
AI 写入文件 → markSessionGeneratedFile(sessionId, path)
                    ↓
AI 删除文件 → isAliceloopGeneratedFile(path) → true → 允许
                                               → false → 拒绝
                    ↓
删除完成 → markGeneratedFileDeleted(path) → 软删除记录
```

- **核心原则**：development 模式下，只能删除 Aliceloop 自己创建的文件
- **跨会话**：文件归属记录全局持久化，即使在不同会话中也能正确追踪
- **rm/rmdir 拦截**：bash 中的 `rm`/`rmdir` 命令被 `runBashAsDelete` 拦截，走同样的删除安全检查
- **目录保护**：非 full-access 模式下只允许删除空目录

#### 附件动态授权 (`sessionRepository.ts`)

- `listSessionAttachmentSandboxRoots(sessionId)` 扫描会话附件，将存储路径动态添加到沙箱根
- 目录附件 → 授予 read + write + cwd
- 文件附件 → 授予 read + write（无 cwd）

---

### ④ 内核层 — `seatbelt.ts` (macOS sandbox-exec)

**职责**：在操作系统内核层面限制子进程，即使应用层检查被绕过也能阻止非法访问。

**适用条件**：
- macOS 系统 + `/usr/bin/sandbox-exec` 存在
- `development` 模式（`full-access` 不启用）
- 仅对 bash 命令生效（文件 I/O 由 Node.js 主进程直接操作，已被策略层保护）

**Profile 生成策略**（SBPL，last-match-wins 语义）：

```scheme
(version 1)
(allow default)

;; 网络：阻断 TCP/UDP，保留 Unix socket（IPC 需要）
(deny network*)
(allow network* (local unix))
(allow network* (remote unix))

;; 文件写入：禁止写 /Users，逐个放行允许目录
(deny file-write* (subpath "/Users"))
(allow file-write* (subpath "<writeRoot1>"))
(allow file-write* (subpath "<writeRoot2>"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "$TMPDIR"))

;; 敏感目录：禁止读取
(deny file-read* (subpath "~/.ssh"))
(deny file-read* (subpath "~/.gnupg"))
(deny file-read* (subpath "~/.aws"))
(deny file-read* (subpath "~/.config"))
(deny file-read* (subpath "~/.env"))
;; 放行项目和数据目录的读取
(allow file-read* (subpath "<readRoot1>"))
```

**防御效果**：

| 攻击向量 | 应用层 (toolPolicy) | 内核层 (seatbelt) |
|----------|--------------------|--------------------|
| `node -e "http.get('http://evil.com')"` | 无法检查 | **deny network*** 阻断 |
| `node -e "fs.writeFileSync('/Users/x/bad','pwned')"` | 参数无法深检 | **deny file-write*** 阻断 |
| `node -e "fs.readFileSync('/Users/x/.ssh/id_rsa')"` | 参数无法深检 | **deny file-read*** 阻断 |
| `cat /etc/hosts` (非允许路径) | **assertCommandArguments** 阻断 | 不限制 (allow default) |

**Linux 兼容性**：`isSeatbeltAvailable()` 在非 macOS 上返回 `false`，自动退化为纯应用层策略。

---

### ⑤ 审计层 — `audit.ts` + `sandboxRunRepository.ts`

**职责**：全量记录每一次沙箱操作的执行结果，提供事后审查和异常检测能力。

**记录内容**：

| 字段 | 说明 |
|------|------|
| `primitive` | 操作类型：read / write / edit / delete / bash |
| `status` | 结果：running → done / blocked / failed |
| `access` | 权限级别：standard / elevated |
| `target_path` | 操作的文件路径 |
| `command` / `args` / `cwd` | bash 命令详情 |
| `detail` | 人类可读的操作描述，含 label 和 access tag |

**持久化**：存储到 SQLite（`sandbox_runs` 表），支持按时间倒序查询（最多 200 条）。

**崩溃恢复**：`reconcileRunningSandboxRuns()` 在 daemon 重启时将仍处于 `"running"` 状态的记录标记为 `"failed"`。

---

## 数据流

一次 bash 命令执行的完整安全流水线：

```
sandbox.runBash({ command: "node", args: ["-e", "..."], cwd: "/project" })
  │
  ├─ [策略层] assertCommand("node") ✓
  ├─ [策略层] assertCwd("/project") ✓
  ├─ [策略层] assertCommandArguments({command, args, cwd}) ✓
  │
  ├─ [身份层] requestBashApproval? → 用户确认
  │
  ├─ [内核层] buildSeatbeltProfile() → SBPL profile
  ├─ [内核层] wrapWithSeatbelt() → sandbox-exec -p <profile> node -e "..."
  │
  ├─ [执行] execFile(sandbox-exec, [...], { env: minimal, timeout: 60s })
  │
  └─ [审计层] createSandboxRun() → finishSandboxRun(done/failed)
```

## Permission Profile 对照表

| 维度 | `development` | `full-access` |
|------|--------------|---------------|
| 文件读取 | 仅 allowedReadRoots | 无限制 |
| 文件写入 | 仅 allowedWriteRoots | 无限制 |
| 命令执行 | 白名单 + 参数深检 | 无限制 |
| 文件删除 | 仅 AI 生成的文件 | 任意文件/目录 |
| 网络访问 | Seatbelt deny | 无限制 |
| 敏感目录 | Seatbelt deny .ssh/.gnupg/.aws/.config | 无限制 |
| Elevated 审批 | 支持逐次授权 | 不需要 |
| Bash 审批 | 可配置 | 不触发 |
| 审计日志 | 全量记录 | 全量记录 |
| Seatbelt | 启用 | 不启用 |

## 测试验证

运行 `npx tsx apps/daemon/scripts/sandboxSmoke.ts`，覆盖：

- 基础 CRUD 操作（read/write/edit/delete）
- 删除安全（仅允许删除 AI 生成文件，阻止非空目录）
- Bash 命令执行与审批流程
- Elevated approval 逐次授权
- Seatbelt 网络封锁
- Seatbelt 文件写入限制
- Seatbelt 允许路径正常写入
- full-access 模式不启用 Seatbelt
- 审计日志完整性
