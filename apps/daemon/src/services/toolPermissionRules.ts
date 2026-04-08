import { resolve, sep } from "node:path";
import type {
  ToolApproval,
  ToolApprovalDecisionOption,
  ToolPermissionRule,
  ToolPermissionRuleToolName,
  ToolPermissionRules,
} from "@aliceloop/runtime-core";

export interface ToolPermissionRequest {
  toolName: Exclude<ToolPermissionRuleToolName, "*">;
  targetPath?: string;
  cwd?: string;
  commandLine?: string;
}

function normalizeResolvedPath(value: string) {
  return resolve(value);
}

function isWithinPrefix(value: string, prefix: string) {
  const resolvedValue = normalizeResolvedPath(value);
  const resolvedPrefix = normalizeResolvedPath(prefix);
  return resolvedValue === resolvedPrefix || resolvedValue.startsWith(`${resolvedPrefix}${sep}`);
}

export function matchesToolPermissionRule(rule: ToolPermissionRule, request: ToolPermissionRequest) {
  if (rule.toolName !== "*" && rule.toolName !== request.toolName) {
    return false;
  }

  if (rule.pathPrefix) {
    if (!request.targetPath || !isWithinPrefix(request.targetPath, rule.pathPrefix)) {
      return false;
    }
  }

  if (rule.cwdPrefix) {
    if (!request.cwd || !isWithinPrefix(request.cwd, rule.cwdPrefix)) {
      return false;
    }
  }

  if (rule.commandPrefix) {
    if (!request.commandLine || !request.commandLine.startsWith(rule.commandPrefix.trim())) {
      return false;
    }
  }

  return true;
}

export function findMatchingToolPermissionRule(
  rules: ToolPermissionRule[],
  request: ToolPermissionRequest,
) {
  return rules.find((rule) => matchesToolPermissionRule(rule, request)) ?? null;
}

function normalizeRuleValue(value: string | undefined) {
  return value?.trim() || undefined;
}

export function toolPermissionRuleEquals(left: ToolPermissionRule, right: ToolPermissionRule) {
  return left.toolName === right.toolName
    && normalizeRuleValue(left.pathPrefix) === normalizeRuleValue(right.pathPrefix)
    && normalizeRuleValue(left.cwdPrefix) === normalizeRuleValue(right.cwdPrefix)
    && normalizeRuleValue(left.commandPrefix) === normalizeRuleValue(right.commandPrefix);
}

export function appendToolPermissionRule(
  rules: ToolPermissionRules,
  behavior: keyof ToolPermissionRules,
  nextRule: ToolPermissionRule,
): ToolPermissionRules {
  const cleanedRules: ToolPermissionRules = {
    allow: behavior === "allow" ? rules.allow : rules.allow.filter((rule) => !toolPermissionRuleEquals(rule, nextRule)),
    deny: behavior === "deny" ? rules.deny : rules.deny.filter((rule) => !toolPermissionRuleEquals(rule, nextRule)),
    ask: behavior === "ask" ? rules.ask : rules.ask.filter((rule) => !toolPermissionRuleEquals(rule, nextRule)),
  };
  const existing = cleanedRules[behavior];
  if (existing.some((rule) => toolPermissionRuleEquals(rule, nextRule))) {
    const rulesChanged = cleanedRules.allow.length !== rules.allow.length
      || cleanedRules.deny.length !== rules.deny.length
      || cleanedRules.ask.length !== rules.ask.length;
    return rulesChanged ? cleanedRules : rules;
  }

  return {
    ...cleanedRules,
    [behavior]: [...existing, nextRule],
  };
}

export function buildToolPermissionRequestFromApproval(approval: Pick<ToolApproval, "toolName" | "cwd" | "commandLine" | "args">): ToolPermissionRequest | null {
  switch (approval.toolName) {
    case "read":
    case "write":
    case "edit":
      return {
        toolName: approval.toolName,
        targetPath: approval.args[0] ? normalizeResolvedPath(approval.args[0]) : undefined,
      };
    case "delete": {
      const pathArg = approval.args.find((arg) => arg && !arg.startsWith("-"));
      return {
        toolName: "delete",
        targetPath: pathArg ? normalizeResolvedPath(pathArg) : undefined,
        cwd: approval.cwd ? normalizeResolvedPath(approval.cwd) : undefined,
        commandLine: approval.commandLine?.trim() || undefined,
      };
    }
    case "bash":
      return {
        toolName: "bash",
        cwd: approval.cwd ? normalizeResolvedPath(approval.cwd) : undefined,
        commandLine: approval.commandLine?.trim() || undefined,
      };
    default:
      return null;
  }
}

export function buildToolPermissionRuleFromApproval(
  approval: Pick<ToolApproval, "toolName" | "cwd" | "commandLine" | "args">,
  decisionOption: ToolApprovalDecisionOption,
): { behavior: "allow" | "deny"; rule: ToolPermissionRule } | null {
  const request = buildToolPermissionRequestFromApproval(approval);
  if (!request) {
    return null;
  }

  const behavior = decisionOption === "allow_always" ? "allow" : decisionOption === "deny_always" ? "deny" : null;
  if (!behavior) {
    return null;
  }

  if ((request.toolName === "write" || request.toolName === "edit" || request.toolName === "read") && request.targetPath) {
    return {
      behavior,
      rule: {
        toolName: request.toolName,
        pathPrefix: request.targetPath,
      },
    };
  }

  if (request.toolName === "delete" && request.targetPath) {
    return {
      behavior,
      rule: {
        toolName: "delete",
        pathPrefix: request.targetPath,
      },
    };
  }

  if (request.commandLine) {
    return {
      behavior,
      rule: {
        toolName: request.toolName,
        ...(request.cwd ? { cwdPrefix: request.cwd } : {}),
        commandPrefix: request.commandLine,
      },
    };
  }

  return null;
}
