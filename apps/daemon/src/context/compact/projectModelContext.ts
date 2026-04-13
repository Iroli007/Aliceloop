import { getRuntimeSettings } from "../../repositories/runtimeSettingsRepository";
import { nowMs, roundMs } from "../../runtime/perfTrace";
import { buildSessionMessagesFromSnapshot, type SessionContextFragments } from "../session/sessionContext";
import { splitSessionTurns } from "../session/rollingSummary";
import { buildCompactionBoundaryBlock } from "./attachments";
import { ensureCheckpointCompact } from "./compact";
import { microCompactMessages } from "./microCompact";
import {
  estimateModelContextTokens,
  resolveKeptRecentTurnsCount,
  shouldCompactContext,
} from "./budget";
import { ensureSessionMemoryFresh } from "./sessionMemory";
import type { CompactionLoadOptions, ProjectedModelContext } from "./types";

export async function projectModelContext(input: {
  sessionId: string;
  sessionContext: SessionContextFragments;
  abortSignal?: AbortSignal;
  options?: CompactionLoadOptions;
}): Promise<ProjectedModelContext> {
  const startedAt = nowMs();
  const snapshot = input.sessionContext.snapshot;
  const requestedRecentTurnsCount = Math.max(
    1,
    input.options?.keepRecentTurnsCount ?? getRuntimeSettings().recentTurnsCount,
  );
  const forceCheckpoint = input.options?.forceCheckpoint ?? false;
  const turns = splitSessionTurns(snapshot.messages);
  const hiddenTurnCount = Math.max(0, turns.length - requestedRecentTurnsCount);

  const sessionMemoryStartedAt = nowMs();
  const sessionMemory = await ensureSessionMemoryFresh({
    sessionId: input.sessionId,
    snapshot,
    recentTurnsCount: requestedRecentTurnsCount,
    abortSignal: input.abortSignal,
    refreshIfStale: forceCheckpoint,
  });
  const sessionMemoryMs = roundMs(nowMs() - sessionMemoryStartedAt);

  const initialMessages = buildSessionMessagesFromSnapshot(snapshot, requestedRecentTurnsCount);
  const initialMicroCompactStartedAt = nowMs();
  const initialMicroCompactedMessages = microCompactMessages(initialMessages);
  const initialMicroCompactMs = roundMs(nowMs() - initialMicroCompactStartedAt);
  const estimatedTokens = estimateModelContextTokens({
    blocks: [
      input.sessionContext.activeTurn,
      input.sessionContext.latestTurn,
      input.sessionContext.sessionFocus,
      sessionMemory.block,
      input.sessionContext.recentToolTranscript || input.sessionContext.recentToolActivity,
      input.sessionContext.recentResearchMemory,
      ...(input.options?.additionalBlocks ?? []),
    ],
    messages: initialMicroCompactedMessages.messages,
  });

  const shouldCompact = shouldCompactContext({
    force: forceCheckpoint,
    hiddenTurnCount,
    estimatedTokens,
  });

  if (!shouldCompact) {
    const boundaryBlock = buildCompactionBoundaryBlock({
      archivedTurnCount: hiddenTurnCount,
      keptRecentTurnsCount: requestedRecentTurnsCount,
      source: "session_memory",
    });

    return {
      messages: initialMicroCompactedMessages.messages,
      boundaryBlock,
      sessionMemoryBlock: sessionMemory.block,
      checkpointSummaryBlock: "",
      toolTranscriptBlock: input.sessionContext.recentToolTranscript,
      usedCheckpoint: false,
      usedSessionMemory: Boolean(sessionMemory.summary.summary),
      boundaryKind: hiddenTurnCount > 0 ? "session_memory" : "none",
      boundaryMessageId: null,
      keptRecentTurnsCount: requestedRecentTurnsCount,
      hiddenTurnCount,
      timings: {
        estimatedContextTokens: estimatedTokens,
        sessionMemoryMs,
        checkpointMs: 0,
        checkpointIncremental: 0,
        microCompactMs: initialMicroCompactMs,
        microCompactedMessages: initialMicroCompactedMessages.compactedCount,
        microCompactedCharsSaved: initialMicroCompactedMessages.savedChars,
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const keptRecentTurnsCount = resolveKeptRecentTurnsCount(requestedRecentTurnsCount, forceCheckpoint);
  const hiddenTurns = turns.slice(0, Math.max(0, turns.length - keptRecentTurnsCount));
  const refreshedSessionMemoryStartedAt = nowMs();
  const refreshedSessionMemory = await ensureSessionMemoryFresh({
    sessionId: input.sessionId,
    snapshot,
    recentTurnsCount: keptRecentTurnsCount,
    abortSignal: input.abortSignal,
    refreshIfStale: true,
  });
  const refreshedSessionMemoryMs = roundMs(nowMs() - refreshedSessionMemoryStartedAt);

  const checkpointStartedAt = nowMs();
  const checkpoint = await ensureCheckpointCompact({
    sessionId: input.sessionId,
    focusState: snapshot.focusState,
    sessionMemory: refreshedSessionMemory.summary,
    hiddenTurns,
    keptRecentTurnsCount,
    recentToolTranscript: input.sessionContext.recentToolTranscript,
    abortSignal: input.abortSignal,
    force: forceCheckpoint,
  });
  const checkpointMs = roundMs(nowMs() - checkpointStartedAt);
  const boundaryBlock = buildCompactionBoundaryBlock({
    archivedTurnCount: hiddenTurns.length,
    keptRecentTurnsCount,
    source: "checkpoint",
  });
  const compactedVisibleMessagesStartedAt = nowMs();
  const compactedVisibleMessages = microCompactMessages(
    buildSessionMessagesFromSnapshot(snapshot, keptRecentTurnsCount),
  );
  const compactedVisibleMessagesMs = roundMs(nowMs() - compactedVisibleMessagesStartedAt);

  return {
    messages: compactedVisibleMessages.messages,
    boundaryBlock,
    sessionMemoryBlock: refreshedSessionMemory.block,
    checkpointSummaryBlock: checkpoint.summaryBlock,
    toolTranscriptBlock: input.sessionContext.recentToolTranscript,
    usedCheckpoint: true,
    usedSessionMemory: Boolean(refreshedSessionMemory.summary.summary),
    boundaryKind: hiddenTurns.length > 0 ? "checkpoint" : "none",
    boundaryMessageId: checkpoint.lastCompactedMessageId,
    keptRecentTurnsCount,
    hiddenTurnCount: hiddenTurns.length,
    timings: {
      estimatedContextTokens: estimatedTokens,
      sessionMemoryMs: sessionMemoryMs + refreshedSessionMemoryMs,
      checkpointMs,
      compactedTurnCount: checkpoint.compactedTurnCount,
      checkpointIncremental: checkpoint.incremental ? 1 : 0,
      microCompactMs: compactedVisibleMessagesMs,
      microCompactedMessages: compactedVisibleMessages.compactedCount,
      microCompactedCharsSaved: compactedVisibleMessages.savedChars,
      checkpointUsedFallback: checkpoint.usedFallback ? 1 : 0,
      checkpointFailureCount: checkpoint.consecutiveFailures,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}
