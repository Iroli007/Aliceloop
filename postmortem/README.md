# Postmortem Registry

> 项目级事故复盘档案。供 AI agent 通过 filesystem-based Agentic RAG 检索，人类通常不需要主动阅读。

## 使用方式

### 自动触发场景

1. **Release 前 (GitHub Workflow)**: AI 分析本次 Release 所有 commits，与已有 postmortem 交叉比对，若命中已知模式则阻断并修复。
2. **Release 后 (GitHub Workflow)**: AI 将本次 Release 的所有 fix commits 结合已有 postmortem 总结为新的尸检报告，自动存入本目录。

### 文件命名规范

```
YYYY-MM-DD-<slug>.md
```

### 每份报告必须包含的字段

| 字段 | 说明 |
|------|------|
| 严重级别 | P0 / P1 / P2 / P3 |
| 事故摘要 | 一句话描述 |
| 事故原因 | 根因分析，区分直接原因和根本原因 |
| 复现步骤 | 可复现的最短路径 |
| 涉及 Commits | 引入 bug 的 commit 和修复 commit |
| 经验教训 | 可执行的规则，不是空话 |
| 预防措施 | checklist，可被 CI/AI 验证 |

### AI Agent 检索指引

当需要判断某个变更是否可能重蹈覆辙时：

1. 读取本 README 获取 TOC
2. 根据变更涉及的模块/关键词，定位相关 postmortem 文件
3. 读取完整报告，提取"事故原因"和"预防措施"
4. 与当前变更交叉比对

---

## TOC

| 日期 | 文件 | 严重级别 | 摘要 |
|------|------|----------|------|
| 2026-03-21 | [2026-03-21-ghost-settings-sidebar.md](./2026-03-21-ghost-settings-sidebar.md) | P1 | Dev 模式环境变量名错误导致 Electron 加载旧 dist 产物，设置侧边栏"删不掉" |
