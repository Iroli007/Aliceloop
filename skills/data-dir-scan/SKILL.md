---
name: data-dir-scan
label: Data Dir Scan
description: 通过绑定脚本列出本地数据目录的一层文件和目录摘要。
status: available
taskType: script-runner
usesSandbox: true
runtimeScriptId: data-dir-scan
---

# data-dir-scan

作用：

- 绑定 `apps/daemon/runtime-scripts/data-dir-scan.ts`
- 快速检查 data 目录内容，方便定位本地状态问题
