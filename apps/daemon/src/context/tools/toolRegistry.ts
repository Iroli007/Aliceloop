import type { ToolSet } from "ai";
import type { createPermissionSandboxExecutor } from "../../services/sandboxExecutor";
import { createSandboxTools } from "./sandboxTools";
import { createManagedTaskTools } from "./managedTaskTools";

type SandboxExecutor = ReturnType<typeof createPermissionSandboxExecutor>;

export function buildToolSet(sandbox: SandboxExecutor): ToolSet {
  const sandboxTools = createSandboxTools(sandbox);
  const managedTaskTools = createManagedTaskTools();

  return {
    ...sandboxTools,
    ...managedTaskTools,
  };
}
