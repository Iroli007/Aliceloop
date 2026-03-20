import { randomUUID } from "node:crypto";
import type { SandboxExecutionAccess } from "@aliceloop/runtime-core";
import { createSandboxRun, finishSandboxRun } from "../../repositories/sandboxRunRepository";
import { SandboxViolationError, type SandboxAuditLogger, type SandboxRunExecution } from "./types";

function formatAuditDetail(label: string, access: SandboxExecutionAccess, detail: string) {
  const accessTag = access === "elevated" ? "[elevated]" : "[standard]";
  return `[${label}]${accessTag} ${detail}`;
}

export function createSandboxAuditLogger(label: string): SandboxAuditLogger {
  return {
    async withRun<T>(input: SandboxRunExecution<T>) {
      const access = input.access ?? "standard";
      const now = new Date().toISOString();
      const run = createSandboxRun({
        id: randomUUID(),
        primitive: input.primitive,
        status: "running",
        targetPath: input.targetPath ?? null,
        command: input.command ?? null,
        args: input.args ?? [],
        cwd: input.cwd ?? null,
        detail: formatAuditDetail(label, access, input.detail),
        createdAt: now,
      });

      try {
        const { result, detail } = await input.execute();
        finishSandboxRun(run.id, {
          status: "done",
          detail: formatAuditDetail(label, access, detail),
        });
        return result;
      } catch (error) {
        finishSandboxRun(run.id, {
          status: error instanceof SandboxViolationError || error instanceof Error && error.name === "ToolApprovalRejectedError"
            ? "blocked"
            : "failed",
          detail: formatAuditDetail(label, access, error instanceof Error ? error.message : "sandbox execution failed"),
        });
        throw error;
      }
    },
  };
}
