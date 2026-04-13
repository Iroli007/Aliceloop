import { basename, dirname, resolve, sep } from "node:path";
import type {
  ToolPermissionRule,
  ToolPermissionRules,
} from "@aliceloop/runtime-core";
import type {
  DeletePathInput,
  EditTextFileInput,
  PermissionSandboxExecutor,
  ReadTextFileInput,
  ReadTextFileWindowInput,
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
import { isReadOnlyBashInput } from "../context/tools/toolExecutionContracts";
import { isOutputRedirectOp, parseBashScriptAst, type ParsedBashRedirect } from "../runtime/sandbox/bashAst";
import { collectPathArguments } from "../runtime/sandbox/toolPolicy";

export type AgentPermissionMode = "auto" | "bypassPermissions" | "plan";
export type AgentPermissionToolName = "read" | "write" | "edit" | "delete" | "bash" | "*";

export interface AgentPermissionContext {
  mode: AgentPermissionMode;
  alwaysAllowRules: ToolPermissionRule[];
  alwaysDenyRules: ToolPermissionRule[];
  alwaysAskRules: ToolPermissionRule[];
  workspaceRoots: string[];
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
  skipStoredRuleAutoResolve?: boolean;
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

const AUTO_BASH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|[;&|(){}])\s*(?:sudo|su|doas|pkexec)\b/i, "privilege escalation"],
  [/(?:^|[;&|(){}])\s*(?:rm|rmdir|unlink|trash|srm|shred)\b/i, "destructive file removal"],
  [/(?:^|[;&|(){}])\s*(?:chmod|chown)\b/i, "permission or ownership change"],
  [/(?:^|[;&|(){}])\s*(?:env|nice|nohup|timeout|command|builtin|xargs)\b[\s\S]*?(?:sudo|su|doas|pkexec|rm|rmdir|unlink|trash|srm|shred|chmod|chown)\b/i, "wrapped dangerous command"],
  [/(?:^|[;&|(){}])\s*(?:bash|sh|zsh|fish)\b[\s\S]*?\s-(?:[a-z]*c[a-z]*)\s[\s\S]*(?:sudo|su|doas|pkexec|rm|rmdir|unlink|trash|srm|shred|chmod|chown|git\b[\s\S]*\b(?:push\b|rm\b|clean\b[\s\S]*(?:\b-f\b|--force)|reset\b[\s\S]*--hard\b)|curl\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b|wget\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b|npm\b[\s\S]*\bpublish\b)/i, "shell script execution"],
  [/\bgit\b[\s\S]*\b(?:push\b|rm\b|clean\b[\s\S]*(?:\b-f\b|--force)|reset\b[\s\S]*--hard\b)/i, "dangerous git operation"],
  [/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/i, "remote shell execution"],
  [/\bgit\b[\s\S]*\b(?:push\b|publish\b)/i, "remote publish operation"],
  [/\bnpm\b[\s\S]*\bpublish\b/i, "package publish"],
];

const STRICT_BASH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|[;&|(){}])\s*(?:sudo|su|doas|pkexec)\b/i, "privilege escalation"],
  [/(?:^|[;&|(){}])\s*rm\b[^;&|\n]*?(?:\s-(?:[A-Za-z]*[rR][A-Za-z]*|[A-Za-z]*f[A-Za-z]*[rR][A-Za-z]*|[A-Za-z]*[rR][A-Za-z]*f[A-Za-z]*)\b|\s--recursive\b)/i, "recursive file removal"],
  [/\bgit\b[\s\S]*\b(?:push\b|clean\b[\s\S]*(?:\b-f\b|--force)|reset\b[\s\S]*--hard\b)/i, "dangerous git operation"],
  [/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/i, "remote shell execution"],
  [/\bkubectl\s+delete\b/i, "destructive infrastructure operation"],
  [/\bterraform\s+destroy\b/i, "destructive infrastructure operation"],
  [/\bnpm\b[\s\S]*\bpublish\b/i, "package publish"],
];

const SENSITIVE_FILE_BASENAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
]);

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".git",
  ".vscode",
  ".idea",
  ".claude",
  ".ssh",
  ".gnupg",
  ".aws",
]);

function stripLeadingEnvAssignments(commandLine: string) {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
  let index = 0;

  while (index < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[index]!)) {
    index += 1;
  }

  return tokens.slice(index).join(" ");
}

function shouldAskForAutoBash(request: AgentPermissionRequest) {
  const commandLine = stripLeadingEnvAssignments(buildCommandLine(request));
  if (!commandLine) {
    return null;
  }

  for (const [pattern, reason] of AUTO_BASH_RISK_PATTERNS) {
    if (pattern.test(commandLine)) {
      return reason;
    }
  }

  return null;
}

function isSensitiveTargetPath(targetPath: string) {
  const normalizedPath = resolve(targetPath);
  const normalizedBasename = basename(normalizedPath).toLowerCase();

  if (normalizedBasename === ".env" || normalizedBasename.startsWith(".env.")) {
    return true;
  }

  if (SENSITIVE_FILE_BASENAMES.has(normalizedBasename)) {
    return true;
  }

  const normalizedSegments = normalizedPath.toLowerCase().split(/[\\/]+/).filter(Boolean);
  return normalizedSegments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment));
}

function extractRedirectTargets(commandLine: string) {
  const matches = commandLine.matchAll(/(?:^|[^\w])(?:>>?|1>>?|2>>?|&>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g);
  const targets: string[] = [];
  for (const match of matches) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

function checkToolContentAsk(request: AgentPermissionRequest): AgentPermissionDecision | null {
  if ((request.toolName === "write" || request.toolName === "edit" || request.toolName === "delete") && request.targetPath) {
    if (isSensitiveTargetPath(request.targetPath)) {
      return {
        behavior: "ask",
        reason: `Tool content ask requires approval for ${request.toolName} of sensitive path`,
        skipStoredRuleAutoResolve: true,
      };
    }
    return null;
  }

  if (request.toolName !== "bash") {
    return null;
  }

  const commandLine = stripLeadingEnvAssignments(buildCommandLine(request));
  if (!commandLine) {
    return null;
  }

  const cwd = resolve(request.cwd ?? process.cwd());
  for (const target of extractRedirectTargets(commandLine)) {
    if (isSensitiveTargetPath(resolve(cwd, target))) {
      return {
        behavior: "ask",
        reason: "Tool content ask requires approval for write to sensitive path",
        skipStoredRuleAutoResolve: true,
      };
    }
  }

  return null;
}

function checkToolSafety(request: AgentPermissionRequest): AgentPermissionDecision | null {
  if (request.toolName !== "bash") {
    return null;
  }

  const commandLine = stripLeadingEnvAssignments(buildCommandLine(request));
  if (!commandLine) {
    return null;
  }

  for (const [pattern, reason] of STRICT_BASH_RISK_PATTERNS) {
    if (pattern.test(commandLine)) {
      return {
        behavior: "ask",
        reason: `Tool safety check requires approval for ${reason}`,
        skipStoredRuleAutoResolve: true,
      };
    }
  }

  return null;
}

function checkToolPermissions(request: AgentPermissionRequest): AgentPermissionDecision | null {
  const contentAskDecision = checkToolContentAsk(request);
  if (contentAskDecision) {
    return contentAskDecision;
  }

  return checkToolSafety(request);
}

function isPathWithinRoots(targetPath: string, roots: string[]) {
  const resolvedTargetPath = resolve(targetPath);
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    return resolvedTargetPath === resolvedRoot || resolvedTargetPath.startsWith(`${resolvedRoot}${sep}`);
  });
}

function arePathArgumentsWithinRoots(
  command: string,
  args: string[],
  cwd: string,
  roots: string[],
) {
  const normalizedCommand = basename(command.trim());
  const pathArguments = collectPathArguments(normalizedCommand, args)
    .filter((entry) => entry.access === "read");
  return pathArguments.every((entry) => isPathWithinRoots(resolve(cwd, entry.value), roots));
}

function areReadRedirectTargetsWithinRoots(
  targets: ParsedBashRedirect[],
  cwd: string,
  roots: string[],
) {
  return targets.every((target) => {
    if (isOutputRedirectOp(target.op)) {
      return false;
    }

    return isPathWithinRoots(resolve(cwd, target.target), roots);
  });
}

function isReadOnlyWorkspaceBashRequest(
  context: AgentPermissionContext,
  request: AgentPermissionRequest,
) {
  if (request.toolName !== "bash" || context.workspaceRoots.length === 0) {
    return false;
  }

  const cwd = resolve(request.cwd ?? process.cwd());
  if (!isPathWithinRoots(cwd, context.workspaceRoots)) {
    return false;
  }

  if (request.script?.trim()) {
    const parsed = parseBashScriptAst(request.script.trim());
    if (parsed.kind !== "simple") {
      return false;
    }

    return parsed.commands.length > 0 && parsed.commands.every((command) => {
      if (!isReadOnlyBashInput({
        command: command.command,
        args: command.args,
      })) {
        return false;
      }

      if (!areReadRedirectTargetsWithinRoots(command.redirects, cwd, context.workspaceRoots)) {
        return false;
      }

      return arePathArgumentsWithinRoots(command.command, command.args, cwd, context.workspaceRoots);
    });
  }

  if (!request.command?.trim()) {
    return false;
  }

  if (!isReadOnlyBashInput({
    command: request.command,
    args: request.args ?? [],
  })) {
    return false;
  }

  return arePathArgumentsWithinRoots(request.command, request.args ?? [], cwd, context.workspaceRoots);
}

function isToolSelfAllowedRequest(context: AgentPermissionContext, request: AgentPermissionRequest) {
  if (request.toolName === "read" && request.targetPath) {
    return isPathWithinRoots(request.targetPath, context.workspaceRoots);
  }

  if ((request.toolName === "write" || request.toolName === "edit") && request.targetPath) {
    return isPathWithinRoots(request.targetPath, context.workspaceRoots);
  }

  if (isReadOnlyWorkspaceBashRequest(context, request)) {
    return true;
  }

  return false;
}

function decideSecondLayerPermission(
  context: AgentPermissionContext,
  request: AgentPermissionRequest,
  normalizedRequest: {
    toolName: AgentPermissionRequest["toolName"];
    targetPath?: string;
    cwd?: string;
    commandLine?: string;
  },
): AgentPermissionDecision | null {
  if (context.mode === "bypassPermissions") {
    return {
      behavior: "allow",
      reason: "Allowed by bypassPermissions mode",
    };
  }

  const allowRule = findMatchingToolPermissionRule(context.alwaysAllowRules, normalizedRequest);
  if (allowRule) {
    return {
      behavior: "allow",
      reason: `Allowed by rule: ${formatRule(allowRule)}`,
    };
  }

  if (isToolSelfAllowedRequest(context, request)) {
    return {
      behavior: "allow",
      reason: `Allowed by tool self-allow check for ${request.toolName}`,
    };
  }

  return null;
}

function decideAutoPermission(request: AgentPermissionRequest): AgentPermissionDecision {
  if (request.toolName === "read" || request.toolName === "write" || request.toolName === "edit" || request.toolName === "delete") {
    return {
      behavior: "ask",
      reason: `Auto mode requires approval for ${request.toolName}`,
    };
  }

  const riskReason = shouldAskForAutoBash(request);
  if (riskReason) {
    return {
      behavior: "ask",
      reason: `Auto mode requires approval for ${riskReason}`,
    };
  }

  return {
    behavior: "ask",
    reason: "Auto mode requires approval for bash outside tool self-allow",
  };
}

export function createDefaultAgentPermissionContext(input?: {
  mode?: AgentPermissionMode;
  shouldAvoidPermissionPrompts?: boolean;
  rules?: ToolPermissionRules;
  workspaceRoots?: string[];
}): AgentPermissionContext {
  return {
    mode: input?.mode ?? "bypassPermissions",
    alwaysAllowRules: [...(input?.rules?.allow ?? [])],
    alwaysDenyRules: input?.rules?.deny ?? [],
    alwaysAskRules: input?.rules?.ask ?? [],
    workspaceRoots: [...(input?.workspaceRoots ?? [])],
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

  const askRule = findMatchingToolPermissionRule(context.alwaysAskRules, normalizedRequest);
  if (askRule) {
    return {
      behavior: "ask",
      reason: `Approval required by rule: ${formatRule(askRule)}`,
    };
  }

  const toolPermissionDecision = checkToolPermissions(request);
  if (toolPermissionDecision) {
    return toolPermissionDecision;
  }

  const secondLayerDecision = decideSecondLayerPermission(context, request, normalizedRequest);
  if (secondLayerDecision) {
    return secondLayerDecision;
  }

  if (context.mode === "plan") {
    return {
      behavior: "allow",
      reason: "Allowed by plan mode",
    };
  }

  if (context.mode === "auto") {
    return decideAutoPermission(request);
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
      skipStoredRuleAutoResolve: decision.skipStoredRuleAutoResolve === true,
    });
    return;
  }

  if (request.toolName === "read" && request.targetPath) {
    await requestSessionToolApproval({
      sessionId: options.sessionId,
      toolCallId: request.toolCallId,
      toolName: "read",
      title: "等待确认读取文件",
      detail: `即将读取 ${request.targetPath}。确认后才会真正执行。`,
      command: "read",
      args: [request.targetPath],
      cwd: dirname(request.targetPath),
      abortSignal: options.abortSignal,
      approvalStateTracker: request.approvalStateTracker,
      skipStoredRuleAutoResolve: decision.skipStoredRuleAutoResolve === true,
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
      skipStoredRuleAutoResolve: decision.skipStoredRuleAutoResolve === true,
    });
    return;
  }

  if (request.toolName === "delete" && request.targetPath) {
    await requestSessionToolApproval({
      sessionId: options.sessionId,
      toolCallId: request.toolCallId,
      toolName: "delete",
      title: "等待确认删除文件",
      detail: `即将删除 ${request.targetPath}。确认后才会真正执行。`,
      command: "delete",
      args: [request.targetPath],
      cwd: dirname(request.targetPath),
      abortSignal: options.abortSignal,
      approvalStateTracker: request.approvalStateTracker,
      skipStoredRuleAutoResolve: decision.skipStoredRuleAutoResolve === true,
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
      skipStoredRuleAutoResolve: decision.skipStoredRuleAutoResolve === true,
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
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.readTextFile(input);
    },

    async readTextFileWindow(input: ReadTextFileWindowInput) {
      await enforceAgentPermission(options, {
        toolName: "read",
        targetPath: resolve(input.targetPath),
        toolCallId: input.toolCallId,
        approvalStateTracker: input.approvalStateTracker,
      });
      return baseSandbox.readTextFileWindow(input);
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
        `agent permission frontdesk mode=${options.permissionContext.mode}: bypassPermissions skips ordinary prompts but still asks for strict safety checks, auto directly allows workspace-local safe reads and asks for the rest, and plan stays on the planning path`,
      );
      return {
        ...basePolicy,
        warnings,
      };
    },
  };
}
