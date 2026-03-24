import type { SandboxRuntimePolicy, SandboxToolPolicy } from "./types";

export function buildSandboxRuntimePolicy(toolPolicy: SandboxToolPolicy): SandboxRuntimePolicy {
  const hasFilesystemBoundary = toolPolicy.allowedReadRoots !== null
    || toolPolicy.allowedWriteRoots !== null
    || toolPolicy.allowedCwdRoots !== null;
  return {
    preferredRuntime: "host",
    allowHostFallback: true,
    reason: toolPolicy.fullAccess
      ? hasFilesystemBoundary
        ? "命令保持全放行，但文件读写和 bash cwd 受配置的工作区边界限制。"
        : "完全访问权限当前通过 host runtime 直接执行，与宿主用户权限保持一致，仅保留审计日志。"
      : "开发模式当前通过 host runtime 执行，默认受限；越界动作应当走单次 elevated。",
  };
}
