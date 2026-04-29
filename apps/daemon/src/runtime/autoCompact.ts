import type { ModelMessage } from "ai";
import type { SessionCompactionState, SessionMemoryState, SessionMessage } from "@aliceloop/runtime-core";
import { createEmptySessionCompactionState } from "../repositories/sessionRepository";

export const SESSION_HOT_TAIL_MESSAGE_COUNT = 8;
export const SESSION_COMPACTION_TRIGGER_MESSAGE_COUNT = 4;
const MAX_CHECKPOINT_SUMMARY_LINES = 18;
const MAX_CHECKPOINT_SUMMARY_CHARS = 3_600;
const MAX_MESSAGE_SUMMARY_CHARS = 220;

function listConversationMessages(messages: SessionMessage[]) {
  return messages.filter((message) => message.role !== "system");
}

function normalizeInline(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeSessionMessage(message: SessionMessage) {
  const role = message.role === "user" ? "User" : "Assistant";
  const content = normalizeInline(message.content);
  const attachmentSummary = message.attachments.length > 0
    ? ` [attachments: ${message.attachments.map((attachment) => attachment.fileName).join(", ")}]`
    : "";
  if (!content && !attachmentSummary) {
    return null;
  }
  const raw = `${content || "(no text)"}${attachmentSummary}`;
  const compact = raw.length > MAX_MESSAGE_SUMMARY_CHARS
    ? `${raw.slice(0, MAX_MESSAGE_SUMMARY_CHARS).trimEnd()}…`
    : raw;
  return `${role}: ${compact}`;
}

function hasSessionMemoryContent(
  sessionMemory: SessionMemoryState | null | undefined,
): sessionMemory is SessionMemoryState {
  return Boolean(
    sessionMemory
    && (
      sessionMemory.currentPhase.trim()
      || sessionMemory.summary.trim()
      || sessionMemory.completed.length > 0
      || sessionMemory.remaining.length > 0
      || sessionMemory.decisions.length > 0
    ),
  );
}

function buildSessionMemoryCheckpointSummary(sessionMemory: SessionMemoryState | null | undefined) {
  if (!hasSessionMemoryContent(sessionMemory)) {
    return "";
  }

  const lines = ["Session memory fallback:"];
  if (sessionMemory.currentPhase.trim()) {
    lines.push(`Current phase: ${normalizeInline(sessionMemory.currentPhase)}`);
  }
  if (sessionMemory.summary.trim()) {
    lines.push(`Summary: ${normalizeInline(sessionMemory.summary)}`);
  }
  if (sessionMemory.completed.length > 0) {
    lines.push(`Completed: ${sessionMemory.completed.map(normalizeInline).join("; ")}`);
  }
  if (sessionMemory.remaining.length > 0) {
    lines.push(`Remaining: ${sessionMemory.remaining.map(normalizeInline).join("; ")}`);
  }
  if (sessionMemory.decisions.length > 0) {
    lines.push(`Decisions: ${sessionMemory.decisions.map(normalizeInline).join("; ")}`);
  }

  return trimCheckpointSummary(lines).join("\n");
}

function splitCheckpointSummary(summary: string) {
  return summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function trimCheckpointSummary(lines: string[]) {
  let trimmed = [...lines];
  if (trimmed.length > MAX_CHECKPOINT_SUMMARY_LINES) {
    trimmed = trimmed.slice(-MAX_CHECKPOINT_SUMMARY_LINES);
  }

  while (trimmed.join("\n").length > MAX_CHECKPOINT_SUMMARY_CHARS && trimmed.length > 1) {
    trimmed = trimmed.slice(1);
  }

  return trimmed;
}

function findAnchorIndex(messages: SessionMessage[], anchorMessageId: string | null) {
  if (!anchorMessageId) {
    return -1;
  }

  return messages.findIndex((message) => message.id === anchorMessageId);
}

function buildHotTailKey(messages: SessionMessage[]) {
  return messages.map((message) => message.id).join(",");
}

export function deriveSessionCompactionState(input: {
  sessionId: string;
  messages: SessionMessage[];
  currentState: SessionCompactionState;
  sessionMemory?: SessionMemoryState;
  hotTailCount?: number;
  triggerMessageCount?: number;
}): SessionCompactionState {
  const hotTailCount = input.hotTailCount ?? SESSION_HOT_TAIL_MESSAGE_COUNT;
  const triggerMessageCount = input.triggerMessageCount ?? SESSION_COMPACTION_TRIGGER_MESSAGE_COUNT;
  const conversationMessages = listConversationMessages(input.messages);
  const emptyState = createEmptySessionCompactionState(input.sessionId);

  if (conversationMessages.length <= hotTailCount) {
    if (
      input.currentState.lastCompactedMessageId === null
      && !input.currentState.checkpointSummary
      && !input.currentState.updatedAt
    ) {
      return input.currentState;
    }

    return {
      ...emptyState,
      updatedAt: new Date().toISOString(),
    };
  }

  const anchorIndex = findAnchorIndex(conversationMessages, input.currentState.lastCompactedMessageId);
  const validCurrentState = anchorIndex >= 0 || input.currentState.lastCompactedMessageId === null
    ? input.currentState
    : emptyState;
  const liveMessages = validCurrentState.lastCompactedMessageId === null
    ? conversationMessages
    : conversationMessages.slice(anchorIndex + 1);

  if (liveMessages.length <= hotTailCount + triggerMessageCount) {
    return {
      ...validCurrentState,
      promptProjectionHotTailKey: buildHotTailKey(liveMessages.slice(-hotTailCount)),
    };
  }

  const absorbedCount = liveMessages.length - hotTailCount;
  const absorbedMessages = liveMessages.slice(0, absorbedCount);
  if (absorbedMessages.length === 0) {
    return validCurrentState;
  }

  const nextSummaryLines = trimCheckpointSummary([
    ...splitCheckpointSummary(validCurrentState.checkpointSummary),
    ...absorbedMessages.map(summarizeSessionMessage).filter((line): line is string => Boolean(line)),
  ]);
  const nextSummary = nextSummaryLines.join("\n")
    || buildSessionMemoryCheckpointSummary(input.sessionMemory);
  const lastCompactedMessageId = absorbedMessages.at(-1)?.id ?? validCurrentState.lastCompactedMessageId;
  const hotTailMessages = liveMessages.slice(absorbedCount);
  const now = new Date().toISOString();

  return {
    ...validCurrentState,
    sessionId: input.sessionId,
    checkpointSummary: nextSummary,
    checkpointVolatileKey: lastCompactedMessageId ?? "",
    checkpointSnapshotVersion: validCurrentState.checkpointSnapshotVersion + 1,
    promptProjectionCarryForwardKey: lastCompactedMessageId ?? "",
    promptProjectionCarryForwardVersion: validCurrentState.promptProjectionCarryForwardVersion + 1,
    promptProjectionHotTailKey: buildHotTailKey(hotTailMessages),
    promptProjectionHotTailVersion: validCurrentState.promptProjectionHotTailVersion + 1,
    compactedTurnCount: validCurrentState.compactedTurnCount + absorbedMessages.length,
    lastCompactedMessageId,
    consecutiveFailures: 0,
    updatedAt: now,
  };
}

export function getCompactedConversationMessages(
  messages: SessionMessage[],
  compactionState: SessionCompactionState,
) {
  const conversationMessages = listConversationMessages(messages);
  const anchorIndex = findAnchorIndex(conversationMessages, compactionState.lastCompactedMessageId);

  if (anchorIndex < 0) {
    return conversationMessages;
  }

  return conversationMessages.slice(anchorIndex + 1);
}

export function buildCompactionSummarySystemMessage(
  compactionState: SessionCompactionState,
): ModelMessage | null {
  if (!compactionState.checkpointSummary.trim()) {
    return null;
  }

  return {
    role: "system",
    content: [
      `## Earlier Conversation Checkpoint`,
      `- Compacted message count: ${compactionState.compactedTurnCount}`,
      compactionState.checkpointSummary,
    ].join("\n"),
  };
}

/**
 * Request-time auto compaction is intentionally disabled.
 * Session history is compacted into persisted checkpoints instead.
 */
export function autoCompactMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages;
}
