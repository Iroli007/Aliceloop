import type { SandboxRuntimeBackend, SandboxRuntimeKind, SandboxRuntimePolicy } from "./types";

interface SandboxRuntimeBrokerOptions {
  runtimes: Partial<Record<SandboxRuntimeKind, SandboxRuntimeBackend>>;
}

export function createSandboxRuntimeBroker(options: SandboxRuntimeBrokerOptions) {
  return {
    selectRuntime(policy: SandboxRuntimePolicy) {
      const preferred = options.runtimes[policy.preferredRuntime];
      if (preferred) {
        return preferred;
      }

      const host = options.runtimes.host;
      if (policy.allowHostFallback && host) {
        return host;
      }

      throw new Error(`Sandbox runtime is unavailable for policy runtime=${policy.preferredRuntime}`);
    },
  };
}
