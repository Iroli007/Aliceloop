# Runtime Scripts

这个目录存放 Aliceloop daemon 可通过 `script-runner` 和 `runtime scripts` API 调用的本地 TypeScript 脚本。

约定：

- 脚本使用 TypeScript / Node，默认通过 `tsx` 执行
- 脚本入口必须可直接运行，不依赖前端环境
- 脚本通过 `ALICELOOP_DATA_DIR` 读取当前 data 目录
- 需要暴露给 daemon 的脚本，必须在 `src/repositories/runtimeCatalogRepository.ts` 里登记
- 想作为技能暴露给上层时，需要在同一个 catalog 里把 `runtimeScriptId` 绑定到对应 skill

当前内置脚本：

- `runtime-overview.ts`
  - 输出当前运行目录、data 目录和传入参数
- `data-dir-scan.ts`
  - 输出 data 目录下一层文件与目录摘要
