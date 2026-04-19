import type { SessionEvent, ToolCallState, ToolCallStatus } from "./domain";

export interface ToolWorkflowEntry {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  createdSeq: number | null;
  createdAt: string;
  updatedAt: string;
  backend: string | null;
  input: unknown | null;
  output: unknown | null;
  inputPreview: string | null;
  resultPreview: string | null;
  error: string | null;
  durationMs: number | null;
  success: boolean | null;
}

interface ToolWorkflowEntryUpdate {
  toolCallId: string;
  toolName: string;
  createdSeq?: number;
  createdAt: string;
  updatedAt?: string;
  status?: ToolCallStatus;
  backend?: string | null;
  input?: unknown;
  output?: unknown;
  inputPreview?: string;
  resultPreview?: string;
  error?: string;
  durationMs?: number;
  success?: boolean;
}

const toolWorkflowStatusOrder: Record<ToolCallStatus, number> = {
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "approval-responded": 3,
  "output-available": 4,
  "output-error": 5,
  "permission-denied": 5,
  "done": 6,
};

function summarizeUnknown(value: unknown, maxLength = 320) {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return null;
    }

    return serialized.length > maxLength ? `${serialized.slice(0, maxLength).trimEnd()}…` : serialized;
  } catch {
    return String(value);
  }
}

export function isToolWorkflowTerminalStatus(status: ToolCallStatus) {
  return status === "done" || status === "output-error" || status === "permission-denied";
}

export function mergeToolWorkflowStatus(current: ToolCallStatus, next?: ToolCallStatus) {
  if (!next) {
    return current;
  }

  if (current === "output-error" || current === "permission-denied") {
    return current;
  }

  if (next === "output-error" || next === "permission-denied") {
    return next;
  }

  if (current === "done") {
    return current;
  }

  if (next === "done") {
    return current === "output-available" ? "done" : current;
  }

  return toolWorkflowStatusOrder[next] >= toolWorkflowStatusOrder[current] ? next : current;
}

export function upsertToolWorkflowEntry(entries: ToolWorkflowEntry[], update: ToolWorkflowEntryUpdate) {
  const existing = entries.find((entry) => entry.toolCallId === update.toolCallId);
  const next = entries.filter((entry) => entry.toolCallId !== update.toolCallId);

  const merged: ToolWorkflowEntry = existing
    ? { ...existing }
    : {
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        status: update.status ?? "input-streaming",
        createdSeq: update.createdSeq ?? null,
        createdAt: update.createdAt,
        updatedAt: update.updatedAt ?? update.createdAt,
        backend: null,
        input: null,
        output: null,
        inputPreview: null,
        resultPreview: null,
        error: null,
        durationMs: null,
        success: null,
      };

  merged.toolName = update.toolName;
  if (merged.createdSeq === null && update.createdSeq !== undefined) {
    merged.createdSeq = update.createdSeq;
  }
  merged.updatedAt = update.updatedAt ?? update.createdAt;
  merged.status = mergeToolWorkflowStatus(merged.status, update.status);

  if (update.backend !== undefined) {
    merged.backend = update.backend;
  }
  if (update.input !== undefined) {
    merged.input = update.input;
  }
  if (update.output !== undefined) {
    merged.output = update.output;
  }
  if (update.inputPreview !== undefined) {
    merged.inputPreview = update.inputPreview;
  }
  if (update.resultPreview !== undefined) {
    merged.resultPreview = update.resultPreview;
  }
  if (update.error !== undefined) {
    merged.error = update.error;
  }
  if (update.durationMs !== undefined) {
    merged.durationMs = update.durationMs;
  }
  if (update.success !== undefined) {
    merged.success = update.success;
  }

  next.push(merged);
  next.sort((left, right) => {
    if (left.createdSeq !== null || right.createdSeq !== null) {
      if (left.createdSeq !== null && right.createdSeq !== null && left.createdSeq !== right.createdSeq) {
        return left.createdSeq - right.createdSeq;
      }

      if (left.createdSeq !== null && right.createdSeq === null) {
        return -1;
      }

      if (left.createdSeq === null && right.createdSeq !== null) {
        return 1;
      }
    }

    return left.createdAt.localeCompare(right.createdAt) || left.toolCallId.localeCompare(right.toolCallId);
  });
  return next;
}

export function applyToolWorkflowEvent(entries: ToolWorkflowEntry[], event: SessionEvent) {
  if (event.type === "tool.call.started") {
    const payload = event.payload as {
      toolCallId?: unknown;
      toolName?: unknown;
      inputPreview?: unknown;
      backend?: unknown;
      state?: unknown;
    };
    if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") {
      return entries;
    }

    return upsertToolWorkflowEntry(entries, {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      createdSeq: event.seq,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      status: typeof payload.state === "string" ? (payload.state as ToolCallStatus) : undefined,
      backend: typeof payload.backend === "string" ? payload.backend : undefined,
      inputPreview: typeof payload.inputPreview === "string" ? payload.inputPreview : undefined,
    });
  }

  if (event.type === "tool.state.change") {
    const payload = event.payload as Partial<ToolCallState>;
    if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string" || !payload.status) {
      return entries;
    }

    return upsertToolWorkflowEntry(entries, {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      createdSeq: event.seq,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      status: payload.status,
      input: payload.input,
      output: payload.output,
      resultPreview: payload.output !== undefined ? (summarizeUnknown(payload.output) ?? undefined) : undefined,
      error: payload.error !== undefined ? (summarizeUnknown(payload.error) ?? undefined) : undefined,
    });
  }

  if (event.type === "tool.call.completed") {
    const payload = event.payload as {
      toolCallId?: unknown;
      toolName?: unknown;
      success?: unknown;
      resultPreview?: unknown;
      durationMs?: unknown;
      backend?: unknown;
    };
    if (typeof payload.toolCallId !== "string" || typeof payload.toolName !== "string") {
      return entries;
    }

    return upsertToolWorkflowEntry(entries, {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      createdSeq: event.seq,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      success: typeof payload.success === "boolean" ? payload.success : undefined,
      resultPreview: typeof payload.resultPreview === "string" ? payload.resultPreview : undefined,
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
      backend: typeof payload.backend === "string" ? payload.backend : undefined,
    });
  }

  return entries;
}

export function buildToolWorkflowEntries(events: SessionEvent[]) {
  return events.reduce<ToolWorkflowEntry[]>((current, event) => {
    return applyToolWorkflowEvent(current, event);
  }, []);
}
