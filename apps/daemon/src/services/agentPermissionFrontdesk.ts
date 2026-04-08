import { dirname, resolve } from "node:path";
import type {
  ToolPermissionRule,
  ToolPermissionRules,
} from "@aliceloop/runtime-core";
import type {
  DeletePathInput,
  EditTextFileInput,
  PermissionSandboxExecutor,
  ReadTextFileInput,
  RunBashInput,
  ToolApprovalStateTracker,
  WriteBinaryFileInput,
  WriteTextFileInput,
} from "../runtime/sandbox/types";
import {
  ToolApprovalRejectedError,
  requestSessionToolApproval,
} from "./sessionToolApprovalService";
import {
  findMatchingToolPermissionRule,
} from "./toolPermissionRules";

export type AgentPermissionMode = "auto" | "bypassPermissions" | "plan";
export type AgentPermissionToolName = "read" | "write" | "edit" | "delete" | "bash" | "*";

export interface AgentPermissionContext {
  mode: AgentPermissionMode;
  alwaysAllowRules: ToolPermissionRule[];
  alwaysDenyRules: ToolPermissionRule[];
  alwaysAskRules: ToolPermissionRule[];
  shouldAvoidPermissionPrompts?: boolean;
}

interface AgentPermissionRequest {
  toolName: Exclude<AgentPermissionToolName, "*">;
  targetPath?: string;
  cwd?: string;
  command?: string;
  args?: string[];
  script?: string | null;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}

interface AgentPermissionDecision {
  behavior: "allow" | "deny" | "ask";
  reason: string;
}

interface CreateAgentPermissionFrontdeskOptions {
  sessionId: string;
  abortSignal: AbortSignal;
  permissionContext: AgentPermissionContext;
}

function buildCommandLine(request: AgentPermissionRequest) {
  if (request.toolName !== "bash") {
    return "";
  }

  if (request.script?.trim()) {
    return request.script.trim();
  }

  return [request.command ?? "", ...(request.args ?? [])]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ")
    .trim();
}

function formatRule(rule: ToolPermissionRule) {
  const parts: string[] = [rule.toolName];
  if (rule.pathPrefix) {
    parts.push(`path=${resolve(rule.pathPrefix)}`);
  }
  if (rule.cwdPrefix) {
    parts.push(`cwd=${resolve(rule.cwdPrefix)}`);
  }
  if (rule.commandPrefix) {
    parts.push(`command=${rule.commandPrefix.trim()}`);
  }
  return parts.join(" ");
}

export function createDefaultAgentPermissionContext(input?: {
  mode?: AgentPermissionMode;
  shouldAvoidPermissionPrompts?: boolean;
  rules?: ToolPermissionRules;
}): AgentPermissionContext {
  return {
    mode: input?.mode ?? "bypassPermissions",
    alwaysAllowRules: [
      { toolName: "read" },
      ...(input?.rules?.allow ?? []),
    ],
    alwaysDenyRules: input?.rules?.deny ?? [],
    alwaysAskRules: input?.rules?.ask ?? [],
    shouldAvoidPermissionPrompts: input?.shouldAvoidPermissionPrompts ?? false,
  };
}

export function decideAgentPermission(
  context: AgentPermissionContext,
  request: AgentPermissionRequest,
): AgentPermissionDecision {
  const normalizedRequest = {
    toolName: request.toolName,
    targetPath: request.targetPath,
    cwd: request.cwd,
    commandLine: buildCommandLine(request) || undefined,
  };
  const denyRule = findMatchingToolPermissionRule(context.alwaysDenyRules, normalizedRequest);
  if (denyRule) {
    return {
      behavior: "deny",
      reason: `Denied by rule: ${formatRule(denyRule)}`,
    };
  }

  const allowRule = findMatchingToolPermissionRule(context.alwaysAllowRules, normalizedRequest);
  if (allowRule) {
    return {
      behavior: "allow",
      reason: `Allowed by rule: ${formatRule(allowRule)}`,
    };
  }

  if (context.mode === "bypassPermissions") {
    return {
      behavior: "allow",
      reason: "Allowed by bypassPermissions mode",
    };
  }

  const askRule = findMatchingToolPermissionRule(context.alwaysAskRules, normalizedRequest);
  if (askRule) {
    return {
      behavior: "ask",
      reason: `Approval required by rule: ${formatRule(askRule)}`,
    };
  }

  if (context.mode === "plan") {
    return {
      behavior: "allow",
      reason: "Allowed by plan mode",
    };
  }

  if (context.mode === "auto") {
    return {
      behavior: "allow",
      reason: "Allowed by auto mode",
    };
  }

  return {
    behavior: "allow",
    reason: "Allowed by default policy",
  };
}

function rejectByPolicy(
  tracker: ToolApprovalStateTracker | undefined,
  message: string,
) {
  tracker?.onResolved?.("rejected", "policy");
  throw new ToolApprovalRejectedError(message);
}

async function enforceAgentPermission(
  options: CreateAgentPermissionFrontdeskOptions,
  request: AgentPermissionRequest,
) {
  const decision = decideAgentPermission(options.permissionContext, request);
  if (decision.behavior === "allow") {
    return;
  }

  if (decision.behavior === "deny") {
    rejectByPolicy(request.approvalStateTracker, `${request.toolName} denied by permission policy: ${decision.reason}`);
  }

  if (options.permissionContext.shouldAvoidPermissionPrompts) {
    rejectByPolicy(
      request.approvalStateTracker,
      `${request.toolName} denied because this context cannot show permission prompts.`,
    );
  }

  if (request.toolName === "write" && request.targetPath) {
    await requestSessionToolApproval({
      sessionId: options.sessionId,
      toolCallId: request.toolCallId,
      toolName: "write",
      title: "等待确认写入文件",
      detail: `即将写入 ${request.targetPath}。确认后才会真正执行。`,
      command: "write",
      args: [request.targetPath],
      cwd: dirname(request.targetPath),
      abortSignal: options.abortSignal,
      approvalStateTracker: request.approvalStateTracker,
    });
    return;
  }

  if (request.toolName === "edit" && request.targetPath) {
    await requestSessionToolApproval({
      sessionId: options.sessionId,
      toolCallId: request.toolCallId,
      toolName: "edit",
      title: "等待确认修改文件",
      detail: `即将修改 ${request.targetPath}。确认后才会真正执行。`,
      command: "edit",
      args: [request.targetPath],
      cwd: dirname(request.targetPath),
      abortSignal: options.abortSignal,
      approvalStateTracker: request.approvalStateTracker,
    });
    return;
  }

  if (request.toolName === "bash") {
    const command = request.command?.trim() || "sh";
    const args = request.script?.trim() ? ["-lc", request.script.trim()] : [...(request.args ?? [])];
    const cwd = request.cwd ? resolve(request.cwd) : process.cwd();
    await requestSessionToolApproval({
      sessionId: options.sessionId,
      toolCallId: request.toolCallId,
      toolName: "bash",
      title: "等待确认执行命令",
      detail: `即将在 ${cwd} 中执行以下命令。确认后才会真正运行。`,
      command,
      args,
      cwd,
      commandLine: buildCommandLine(request),
      abortSignal: options.abortSignal,
      approvalStateTracker: request.approvalStateTracker,
    });
    return;
  }

  rejectByPolicy(
    request.approvalStateTracker,
    `${request.toolName} denied because no permission request handler is defined.`,
  );
}

export function createAgentPermissionFrontdesk(
  baseSandbox: PermissionSandboxExecutor,
  options: CreateAgentPermissionFrontdeskOptions,
): PermissionSandboxExecutor {
  const basePolicy = baseSandbox.describePolicy();

  return {
    async readTextFile(input: ReadTextFileInput) {
      await enforceAgentPermission(options, {
        toolName: "read",
        targetPath: resolve(input.targetPath),
      });
      return baseSandbox.readTextFile(input);
    },

    async writeBinaryFile(input: WriteBinaryFileInput) {
      await enforceAgentPermission(options, {
        toolName: "write",
        targetPath: resolve(input.targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.writeBinaryFile(input);
    },

    async writeTextFile(input: WriteTextFileInput) {
      await enforceAgentPermission(options, {
        toolName: "write",
        targetPath: resolve(input.targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.writeTextFile(input);
    },

    async editTextFile(input: EditTextFileInput) {
      await enforceAgentPermission(options, {
        toolName: "edit",
        targetPath: resolve(input.targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.editTextFile(input);
    },

    async deletePath(input: DeletePathInput) {
      await enforceAgentPermission(options, {
        toolName: "delete",
        targetPath: resolve(input.targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.deletePath(input);
    },

    async runBash(input: RunBashInput) {
      await enforceAgentPermission(options, {
        toolName: "bash",
        command: input.command,
        args: input.args ?? [],
        script: input.script?.trim() || null,
        cwd: resolve(input.cwd ?? basePolicy.defaultCwd ?? process.cwd()),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.runBash(input);
    },

    describePolicy() {
      const warnings = basePolicy.warnings.filter((warning) => {
        return warning !== "bash approval hook is not configured; all whitelisted commands run without confirmation";
      });
      warnings.push(
        `agent permission frontdesk mode=${options.permissionContext.mode}: bypassPermissions skips prompts, auto follows explicit ask rules, and plan stays on the planning path`,
      );
      return {
        ...basePolicy,
        warnings,
      };
    },
  };
}
