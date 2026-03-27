---
name: error-recovery
description: 当工具调用失败或遇到错误时，自动尝试恢复或提供替代方案
trigger: 检测到tool返回error字段，或连续失败
---

# Error Recovery Skill

自动处理工具错误，避免agent因单个失败而中断。

## 恢复策略

1. **网络错误** - 自动重试3次
2. **参数错误** - 简化参数后重试
3. **超时错误** - 增加timeout后重试
4. **权限错误** - 提示用户并尝试替代方案

## 示例

```
Tool失败: browser_navigate timeout
→ 自动重试，使用更短的waitUntil
→ 仍失败则降级到web_fetch
```
