import type { ToolApprovalDecisionOption } from "@aliceloop/runtime-core";
import type { ToolApprovalStateTracker } from "../runtime/sandbox/types";
import { randomUUID } from "node:crypto";
import {
  appendRuntimeToolPermissionRule,
  getRuntimeSettings,
} from "../repositories/runtimeSettingsRepository";
import { getSessionPlanModeState } from "../repositories/sessionPlanModeRepository";
import { appendSessionEvent } from "../repositories/sessionRepository";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  createPendingToolApproval,
  getFirstPendingQuestionApproval,
  getPendingToolApproval,
  resolvePendingToolApproval,
} from "./toolApprovalBroker";
import {
  buildToolPermissionRequestFromApproval,
  buildToolPermissionRuleFromApproval,
  findMatchingToolPermissionRule,
} from "./toolPermissionRules";

export class ToolApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`Tool approval was not found: ${approvalId}`);
    this.name = "ToolApprovalNotFoundError";
  }
}

export class ToolApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalRejectedError";
  }
}

export interface SessionQuestionOption {
  label: string;
  description?: string | null;
}

export interface SessionQuestionPrompt {
  header: string;
  question: string;
  options: SessionQuestionOption[];
  multiSelect?: boolean;
}

function summarizeCommandLine(command: string, args: string[]) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ").trim();
}

function getDefaultDecisionOption(status: "approved" | "rejected"): ToolApprovalDecisionOption {
  return status === "approved" ? "allow_once" : "deny_once";
}

function normalizeDecisionOption(
  status: "approved" | "rejected",
  decisionOption?: ToolApprovalDecisionOption | null,
) {
  const normalized = decisionOption ?? getDefaultDecisionOption(status);
  if (status === "approved" && (normalized === "deny_once" || normalized === "deny_always")) {
    throw new Error("tool_approval_option_status_mismatch");
  }
  if (status === "rejected" && (normalized === "allow_once" || normalized === "allow_always")) {
    throw new Error("tool_approval_option_status_mismatch");
  }
  return normalized;
}

function maybeAutoResolveByStoredRule(input: {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  title: string;
  detail: string;
  command: string;
  args: string[];
  cwd: string;
  commandLine: string;
  kind: "command" | "question";
  approvalStateTracker?: ToolApprovalStateTracker;
  skipStoredRuleAutoResolve?: boolean;
}) {
  if (input.skipStoredRuleAutoResolve) {
    return null;
  }

  if (input.kind !== "command") {
    return null;
  }

  const request = buildToolPermissionRequestFromApproval({
    toolName: input.toolName,
    cwd: input.cwd,
    commandLine: input.commandLine,
    args: input.args,
  });
  if (!request) {
    return null;
  }

  const rules = getRuntimeSettings().toolPermissionRules;
  const denyRule = findMatchingToolPermissionRule(rules.deny, request);
  if (denyRule) {
    input.approvalStateTracker?.onResolved?.("rejected", "policy");
    throw new ToolApprovalRejectedError(`${input.toolName} rejected by stored permission rule.`);
  }

  const allowRule = findMatchingToolPermissionRule(rules.allow, request);
  if (allowRule) {
    input.approvalStateTracker?.onResolved?.("approved", "policy");
    return {
      autoResolved: true as const,
    };
  }

  return null;
}

export async function requestSessionToolApproval(input: {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  title: string;
  detail: string;
  command: string;
  args: string[];
  cwd: string;
  commandLine?: string;
  abortSignal: AbortSignal;
  approvalStateTracker?: ToolApprovalStateTracker;
  kind?: "command" | "question";
  question?: SessionQuestionPrompt | null;
  skipStoredRuleAutoResolve?: boolean;
}) {
  if (input.abortSignal.aborted) {
    throw new Error("Agent loop aborted before tool approval was requested.");
  }

  if (input.kind === "question" && !getSessionPlanModeState(input.sessionId).active) {
    input.approvalStateTracker?.onResolved?.("rejected", "policy");
    throw new ToolApprovalRejectedError("ask_user_question is only available in plan mode.");
  }
  if (input.kind === "question" && (input.question?.multiSelect || (input.question?.options.length ?? 0) > 2)) {
    input.approvalStateTracker?.onResolved?.("rejected", "policy");
    throw new ToolApprovalRejectedError("ask_user_question must ask one small clarification at a time.");
  }

  const commandLine = input.commandLine ?? summarizeCommandLine(input.command, input.args);
  const autoResolved = maybeAutoResolveByStoredRule({
    ...input,
    commandLine,
    kind: input.kind ?? "command",
  });
  if (autoResolved?.autoResolved) {
    return;
  }

  const { approval, waitForResolution } = createPendingToolApproval(
    {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName,
      kind: input.kind ?? "command",
      title: input.title,
      detail: input.detail,
      commandLine,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      question: input.question ?? null,
      decisionOption: null,
      requestedAt: new Date().toISOString(),
    },
    {
      abortSignal: input.abortSignal,
      onResolved(resolvedApproval) {
        if (resolvedApproval.status === "approved" || resolvedApproval.status === "rejected") {
          input.approvalStateTracker?.onResolved?.(
            resolvedApproval.status,
            input.abortSignal.aborted ? "abort" : "user",
          );
        }
        const event = appendSessionEvent(input.sessionId, "tool.approval.resolved", {
          approval: resolvedApproval,
        }, resolvedApproval.resolvedAt ?? new Date().toISOString());
        publishSessionEvent(event);
      },
    },
  );

  const requestedEvent = appendSessionEvent(input.sessionId, "tool.approval.requested", {
    approval,
  }, approval.requestedAt);
  publishSessionEvent(requestedEvent);
  input.approvalStateTracker?.onRequested?.();

  const resolvedApproval = await waitForResolution;
  if (resolvedApproval.status === "approved") {
    return;
  }

  if (input.abortSignal.aborted) {
    throw new Error("Agent loop aborted while waiting for tool approval.");
  }

  throw new ToolApprovalRejectedError(`${input.toolName} rejected by user: ${resolvedApproval.commandLine}`);
}

export async function requestSessionBashApproval(input: {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  abortSignal: AbortSignal;
  toolCallId?: string;
  approvalStateTracker?: ToolApprovalStateTracker;
}) {
  return requestSessionToolApproval({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: "bash",
    title: "等待确认 bash 指令",
    detail: `将要在 ${input.cwd} 中执行以下命令。确认后才会真正运行。`,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    abortSignal: input.abortSignal,
    approvalStateTracker: input.approvalStateTracker,
  });
}

function resolveSessionToolApproval(
  sessionId: string,
  approvalId: string,
  status: "approved" | "rejected",
  responseText?: string | null,
  decisionOption?: ToolApprovalDecisionOption | null,
) {
  const pendingApproval = getPendingToolApproval(approvalId);
  if (!pendingApproval || pendingApproval.sessionId !== sessionId) {
    throw new ToolApprovalNotFoundError(approvalId);
  }

  const normalizedDecisionOption = normalizeDecisionOption(status, decisionOption);
  const persistedRule = buildToolPermissionRuleFromApproval(pendingApproval, normalizedDecisionOption);
  if (persistedRule) {
    appendRuntimeToolPermissionRule(persistedRule.behavior, persistedRule.rule);
  }

  const resolvedApproval = resolvePendingToolApproval(
    approvalId,
    status,
    responseText,
    normalizedDecisionOption,
  );
  if (!resolvedApproval) {
    throw new ToolApprovalNotFoundError(approvalId);
  }

  return resolvedApproval;
}

export function approveSessionToolApproval(
  sessionId: string,
  approvalId: string,
  responseText?: string | null,
  decisionOption?: ToolApprovalDecisionOption | null,
) {
  return resolveSessionToolApproval(sessionId, approvalId, "approved", responseText, decisionOption);
}

export function rejectSessionToolApproval(
  sessionId: string,
  approvalId: string,
  responseText?: string | null,
  decisionOption?: ToolApprovalDecisionOption | null,
) {
  return resolveSessionToolApproval(sessionId, approvalId, "rejected", responseText, decisionOption);
}

export function getPendingSessionQuestionApproval(sessionId: string) {
  if (!getSessionPlanModeState(sessionId).active) {
    return null;
  }
  return getFirstPendingQuestionApproval(sessionId);
}
