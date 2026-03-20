import { randomUUID } from "node:crypto";
import { appendSessionEvent } from "../repositories/sessionRepository";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  createPendingToolApproval,
  getPendingToolApproval,
  resolvePendingToolApproval,
} from "./toolApprovalBroker";

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

function summarizeCommandLine(command: string, args: string[]) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ").trim();
}

export async function requestSessionToolApproval(input: {
  sessionId: string;
  toolName: string;
  title: string;
  detail: string;
  command: string;
  args: string[];
  cwd: string;
  commandLine?: string;
  abortSignal: AbortSignal;
}) {
  if (input.abortSignal.aborted) {
    throw new Error("Agent loop aborted before tool approval was requested.");
  }

  const commandLine = input.commandLine ?? summarizeCommandLine(input.command, input.args);
  const { approval, waitForResolution } = createPendingToolApproval(
    {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      title: input.title,
      detail: input.detail,
      commandLine,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      requestedAt: new Date().toISOString(),
    },
    {
      abortSignal: input.abortSignal,
      onResolved(resolvedApproval) {
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
}) {
  return requestSessionToolApproval({
    sessionId: input.sessionId,
    toolName: "sandbox_bash",
    title: "等待确认 bash 指令",
    detail: `将要在 ${input.cwd} 中执行以下命令。确认后才会真正运行。`,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    abortSignal: input.abortSignal,
  });
}

function resolveSessionToolApproval(
  sessionId: string,
  approvalId: string,
  status: "approved" | "rejected",
) {
  const pendingApproval = getPendingToolApproval(approvalId);
  if (!pendingApproval || pendingApproval.sessionId !== sessionId) {
    throw new ToolApprovalNotFoundError(approvalId);
  }

  const resolvedApproval = resolvePendingToolApproval(approvalId, status);
  if (!resolvedApproval) {
    throw new ToolApprovalNotFoundError(approvalId);
  }

  return resolvedApproval;
}

export function approveSessionToolApproval(sessionId: string, approvalId: string) {
  return resolveSessionToolApproval(sessionId, approvalId, "approved");
}

export function rejectSessionToolApproval(sessionId: string, approvalId: string) {
  return resolveSessionToolApproval(sessionId, approvalId, "rejected");
}
