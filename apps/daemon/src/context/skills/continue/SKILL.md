---
name: continue
description: 当agent因maxIterations中断时，继续执行未完成的任务。用户说"继续"时自动触发。
trigger: 用户说"继续"、"接着"、"go on"等，或agent检测到上一轮因步数限制中断
---

# Continue Skill

当agent因达到maxIterations限制而中断时，使用此skill继续执行。

## 使用场景

- 上一轮对话因"reached maximum iterations"中断
- 任务未完成，需要继续执行
- 用户明确要求"继续"

## 工作原理

1. 检查上一轮是否因步数限制中断
2. 恢复上下文和未完成的目标
3. 继续执行剩余步骤

## 示例

用户: "继续"
→ 触发此skill，从中断点恢复执行
