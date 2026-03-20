import type { SandboxRuntimePolicy, SandboxToolPolicy } from "./types";

export function buildSandboxRuntimePolicy(toolPolicy: SandboxToolPolicy): SandboxRuntimePolicy {
  return {
    preferredRuntime: "host",
    allowHostFallback: true,
    reason: toolPolicy.fullAccess
      ? "完全访问权限当前通过 host runtime 直接执行，与宿主用户权限保持一致，仅保留审计日志。"
      : "开发模式当前通过 host runtime 执行，默认受限；越界动作应当走单次 elevated。",
  };
}
