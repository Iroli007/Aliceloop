# Project Skills

这个目录统一存放 Aliceloop 的项目级 skill 定义。

约定：

- 每个 skill 使用单独目录：`skills/<skill-id>/SKILL.md`
- `SKILL.md` 顶部使用简单 frontmatter
- daemon 通过读取这些 `SKILL.md` 生成 `/api/skills` catalog
- 前端不再维护第二份真实 skill 清单，只消费 daemon 返回的数据
- `runtime scripts` 放在 `apps/daemon/runtime-scripts`
- skill 可以绑定 runtime script，但 skill 不等于 script

当前 frontmatter 字段：

- `name`
- `label`
- `description`
- `status`
- `taskType`
- `usesSandbox`
- `runtimeScriptId`

注意：

- 这里定义的是 skill catalog，不等于完整 agent loop
- Aliceloop 当前还没有实现通用 agent loop
- 现在能跑的是 daemon、queue、provider runner、managed tasks 和 permission sandbox
