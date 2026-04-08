import type { ToolApproval, ToolApprovalDecisionOption, ToolApprovalStatus } from "@aliceloop/runtime-core";

type ResolvedToolApprovalStatus = Extract<ToolApprovalStatus, "approved" | "rejected">;

interface CreatePendingToolApprovalOptions {
  abortSignal?: AbortSignal;
  onResolved?: (approval: ToolApproval) => void;
}

interface PendingToolApprovalEntry {
  approval: ToolApproval;
  settle: (status: ResolvedToolApprovalStatus, responseText?: string | null, decisionOption?: ToolApprovalDecisionOption | null) => ToolApproval | null;
}

const pendingToolApprovalsById = new Map<string, PendingToolApprovalEntry>();
const pendingToolApprovalIdsBySession = new Map<string, Set<string>>();

function addPendingToolApprovalToSession(sessionId: string, approvalId: string) {
  const current = pendingToolApprovalIdsBySession.get(sessionId) ?? new Set<string>();
  current.add(approvalId);
  pendingToolApprovalIdsBySession.set(sessionId, current);
}

function removePendingToolApprovalFromSession(sessionId: string, approvalId: string) {
  const current = pendingToolApprovalIdsBySession.get(sessionId);
  if (!current) {
    return;
  }

  current.delete(approvalId);
  if (current.size === 0) {
    pendingToolApprovalIdsBySession.delete(sessionId);
  }
}

export function createPendingToolApproval(
  input: Omit<ToolApproval, "status" | "resolvedAt">,
  options: CreatePendingToolApprovalOptions = {},
) {
  const approval: ToolApproval = {
    ...input,
    kind: input.kind ?? "command",
    question: input.question ?? null,
    responseText: null,
    status: "pending",
    resolvedAt: null,
  };

  let resolveWaiter: (approval: ToolApproval) => void = () => {};
  const waitForResolution = new Promise<ToolApproval>((resolve) => {
    resolveWaiter = resolve;
  });

  let settled = false;
  let cleanupAbortListener = () => {};

  const settle = (
    status: ResolvedToolApprovalStatus,
    responseText?: string | null,
    decisionOption?: ToolApprovalDecisionOption | null,
  ) => {
    if (settled) {
      return null;
    }

    settled = true;
    cleanupAbortListener();
    pendingToolApprovalsById.delete(approval.id);
    removePendingToolApprovalFromSession(approval.sessionId, approval.id);

    const resolvedApproval: ToolApproval = {
      ...approval,
      decisionOption: decisionOption ?? null,
      responseText: responseText?.trim() ? responseText.trim() : null,
      status,
      resolvedAt: new Date().toISOString(),
    };

    resolveWaiter(resolvedApproval);
    options.onResolved?.(resolvedApproval);
    return resolvedApproval;
  };

  addPendingToolApprovalToSession(approval.sessionId, approval.id);
  pendingToolApprovalsById.set(approval.id, {
    approval,
    settle,
  });

  if (options.abortSignal) {
    const handleAbort = () => {
      settle("rejected");
    };

    options.abortSignal.addEventListener("abort", handleAbort, { once: true });
    cleanupAbortListener = () => {
      options.abortSignal?.removeEventListener("abort", handleAbort);
    };

    if (options.abortSignal.aborted) {
      settle("rejected");
    }
  }

  return {
    approval,
    waitForResolution,
  };
}

export function getPendingToolApproval(approvalId: string) {
  return pendingToolApprovalsById.get(approvalId)?.approval ?? null;
}

export function getFirstPendingQuestionApproval(sessionId: string) {
  return listPendingToolApprovals(sessionId).find((approval) => approval.kind === "question" && approval.question) ?? null;
}

export function listPendingToolApprovals(sessionId: string) {
  const approvalIds = pendingToolApprovalIdsBySession.get(sessionId);
  if (!approvalIds) {
    return [] as ToolApproval[];
  }

  return [...approvalIds]
    .map((approvalId) => pendingToolApprovalsById.get(approvalId)?.approval ?? null)
    .filter((approval): approval is ToolApproval => Boolean(approval))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

export function resolvePendingToolApproval(
  approvalId: string,
  status: ResolvedToolApprovalStatus,
  responseText?: string | null,
  decisionOption?: ToolApprovalDecisionOption | null,
) {
  return pendingToolApprovalsById.get(approvalId)?.settle(status, responseText, decisionOption) ?? null;
}
