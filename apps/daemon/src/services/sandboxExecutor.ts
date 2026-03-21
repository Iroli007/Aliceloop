import { createSandboxAuditLogger } from "../runtime/sandbox/audit";
import { createSandboxRuntimeBroker } from "../runtime/sandbox/runtimeBroker";
import { buildSandboxRuntimePolicy } from "../runtime/sandbox/runtimePolicy";
import { createHostSandboxRuntime } from "../runtime/sandbox/runtimes/hostRuntime";
import { isSeatbeltAvailable } from "../runtime/sandbox/seatbelt";
import {
  buildSandboxToolPolicy,
  getDefaultSandboxRoots,
  listDefaultAllowedCommands,
} from "../runtime/sandbox/toolPolicy";
import {
  SandboxViolationError,
  type PermissionSandboxExecutor,
  type SandboxExecutorOptions,
  type SandboxRun,
} from "../runtime/sandbox/types";

const hostRuntime = createHostSandboxRuntime();
const runtimeBroker = createSandboxRuntimeBroker({
  runtimes: {
    host: hostRuntime,
  },
});

export { SandboxViolationError };

export function createPermissionSandboxExecutor(options: SandboxExecutorOptions): PermissionSandboxExecutor {
  const toolPolicy = buildSandboxToolPolicy(options);
  const runtimePolicy = buildSandboxRuntimePolicy(toolPolicy);
  const runtime = runtimeBroker.selectRuntime(runtimePolicy);
  const seatbeltEnabled = !toolPolicy.fullAccess && isSeatbeltAvailable();
  const context = {
    label: options.label,
    toolPolicy,
    runtimePolicy,
    audit: createSandboxAuditLogger(options.label),
    defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
    maxBufferBytes: options.maxBufferBytes ?? 1024 * 1024,
    seatbeltEnabled,
    seenBashApprovalFingerprints: new Set<string>(),
    requestBashApproval: options.requestBashApproval,
    requestElevatedApproval: options.requestElevatedApproval,
    noteCreatedFile: options.noteCreatedFile,
    canDeleteFile: options.canDeleteFile,
    noteDeletedFile: options.noteDeletedFile,
  };

  return {
    readTextFile(input) {
      return runtime.readTextFile(context, input);
    },

    writeBinaryFile(input) {
      return runtime.writeBinaryFile(context, input);
    },

    writeTextFile(input) {
      return runtime.writeTextFile(context, input);
    },

    editTextFile(input) {
      return runtime.editTextFile(context, input);
    },

    deletePath(input) {
      return runtime.deletePath(context, input);
    },

    runBash(input) {
      return runtime.runBash(context, input);
    },

    describePolicy() {
      const warnings: string[] = [];
      if (toolPolicy.fullAccess) {
        warnings.push(
          "full-access mode skips all path, command, and argument restrictions",
          "all file system and bash operations run with the current host user's broad access",
        );
      }
      if (toolPolicy.permissionProfile === "development" && !toolPolicy.requiresBashApproval) {
        warnings.push("bash approval hook is not configured; all whitelisted commands run without confirmation");
      }
      if (toolPolicy.permissionProfile === "development") {
        warnings.push("development mode reads only project, data, uploads, and explicitly granted extra read roots");
        if (toolPolicy.supportsElevatedActions && options.requestElevatedApproval) {
          warnings.push("out-of-policy write, edit, and bash actions can request a single elevated approval");
        } else {
          warnings.push("elevated approval hook is not configured; out-of-policy actions will be blocked");
        }
      }
      return {
        label: options.label,
        permissionProfile: toolPolicy.permissionProfile,
        runtimeKind: runtime.kind,
        runtimeReason: runtimePolicy.reason,
        requiresBashApproval: toolPolicy.requiresBashApproval,
        elevatedAccess: toolPolicy.elevatedAccess,
        supportsElevatedActions: toolPolicy.supportsElevatedActions,
        allowedReadRoots: toolPolicy.allowedReadRoots ?? ["<all>"],
        allowedWriteRoots: toolPolicy.allowedWriteRoots ?? ["<all>"],
        allowedCwdRoots: toolPolicy.allowedCwdRoots ?? ["<all>"],
        allowedCommands: toolPolicy.fullAccess ? ["<all>"] : toolPolicy.allowedCommands,
        warnings,
      };
    },
  };
}

export async function readTextThroughSandbox(
  targetPath: string,
  options: Pick<SandboxExecutorOptions, "label" | "extraReadRoots">,
) {
  const sandbox = createPermissionSandboxExecutor(options);
  return sandbox.readTextFile({
    targetPath,
  });
}

export async function writeBinaryThroughSandbox(
  targetPath: string,
  content: Uint8Array,
  options: Pick<SandboxExecutorOptions, "label" | "extraWriteRoots">,
) {
  const sandbox = createPermissionSandboxExecutor(options);
  return sandbox.writeBinaryFile({
    targetPath,
    content,
  });
}

export type { PermissionSandboxExecutor, SandboxExecutorOptions, SandboxRun };
export { getDefaultSandboxRoots, listDefaultAllowedCommands };
