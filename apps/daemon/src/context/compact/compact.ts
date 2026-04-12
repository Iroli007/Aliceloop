import { generateText } from "ai";
import type { SessionFocusState, SessionRollingSummary } from "@aliceloop/runtime-core";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";
import {
  getSessionCompactionState,
  updateSessionCompactionState,
} from "../../repositories/sessionRepository";
import type { SessionTurn } from "../session/rollingSummary";
import {
  buildCheckpointSummaryBlock,
  buildIncrementalCheckpointSummaryPrompt,
  buildIncrementalFallbackCheckpointSummary,
  buildCheckpointSummaryPrompt,
  buildFallbackCheckpointSummary,
  extractSummaryFromXml,
} from "./summaryPrompt";
import type { CheckpointSummaryResult } from "./types";

const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

function getLastHiddenMessageId(hiddenTurns: SessionTurn[]) {
  const lastTurn = hiddenTurns.at(-1);
  const lastMessage = lastTurn?.messages.at(-1);
  return lastMessage?.id ?? null;
}

async function generateCheckpointSummary(input: {
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  hiddenTurns: SessionTurn[];
  keptRecentTurnsCount: number;
  existingCheckpointSummary?: string;
  previousCompactedTurnCount?: number;
  abortSignal?: AbortSignal;
}) {
  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    return {
      summary: input.existingCheckpointSummary
        ? buildIncrementalFallbackCheckpointSummary({
            existingCheckpointSummary: input.existingCheckpointSummary,
            focusState: input.focusState,
            sessionMemory: input.sessionMemory,
            newHiddenTurns: input.hiddenTurns,
          })
        : buildFallbackCheckpointSummary(input),
      usedFallback: true,
    };
  }

  const response = await generateText({
    model: createProviderModel(provider),
    abortSignal: input.abortSignal,
    temperature: 0.1,
    prompt: input.existingCheckpointSummary
      ? buildIncrementalCheckpointSummaryPrompt({
          focusState: input.focusState,
          sessionMemory: input.sessionMemory,
          existingCheckpointSummary: input.existingCheckpointSummary,
          previousCompactedTurnCount: input.previousCompactedTurnCount ?? 0,
          newHiddenTurns: input.hiddenTurns,
          keptRecentTurnsCount: input.keptRecentTurnsCount,
        })
      : buildCheckpointSummaryPrompt(input),
  });

  const summary = extractSummaryFromXml(response.text) || response.text.trim();
  if (!summary) {
    return {
      summary: input.existingCheckpointSummary
        ? buildIncrementalFallbackCheckpointSummary({
            existingCheckpointSummary: input.existingCheckpointSummary,
            focusState: input.focusState,
            sessionMemory: input.sessionMemory,
            newHiddenTurns: input.hiddenTurns,
          })
        : buildFallbackCheckpointSummary(input),
      usedFallback: true,
    };
  }

  return {
    summary,
    usedFallback: false,
  };
}

function canExtendCheckpointIncrementally(input: {
  checkpointSummary: string;
  compactedTurnCount: number;
  lastCompactedMessageId: string | null;
  hiddenTurns: SessionTurn[];
}) {
  if (
    !input.checkpointSummary
    || input.compactedTurnCount <= 0
    || input.hiddenTurns.length <= input.compactedTurnCount
  ) {
    return false;
  }

  const boundaryTurn = input.hiddenTurns[input.compactedTurnCount - 1];
  const boundaryMessageId = boundaryTurn?.messages.at(-1)?.id ?? null;
  return Boolean(boundaryMessageId && boundaryMessageId === input.lastCompactedMessageId);
}

export async function ensureCheckpointCompact(input: {
  sessionId: string;
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  hiddenTurns: SessionTurn[];
  keptRecentTurnsCount: number;
  abortSignal?: AbortSignal;
  force: boolean;
}): Promise<CheckpointSummaryResult> {
  const current = getSessionCompactionState(input.sessionId);
  const compactedTurnCount = input.hiddenTurns.length;
  const lastHiddenMessageId = getLastHiddenMessageId(input.hiddenTurns);
  const incremental = canExtendCheckpointIncrementally({
    checkpointSummary: current.checkpointSummary,
    compactedTurnCount: current.compactedTurnCount,
    lastCompactedMessageId: current.lastCompactedMessageId,
    hiddenTurns: input.hiddenTurns,
  });
  const turnsToSummarize = incremental
    ? input.hiddenTurns.slice(current.compactedTurnCount)
    : input.hiddenTurns;
  const currentIsFresh = Boolean(
    current.checkpointSummary
    && current.compactedTurnCount === compactedTurnCount
    && current.lastCompactedMessageId === lastHiddenMessageId,
  );

  if (currentIsFresh && !input.force) {
    return {
      summary: current.checkpointSummary,
      summaryBlock: buildCheckpointSummaryBlock(current.checkpointSummary, compactedTurnCount),
      compactedTurnCount,
      lastCompactedMessageId: lastHiddenMessageId,
      incremental: false,
      usedFallback: false,
      consecutiveFailures: current.consecutiveFailures,
      updatedAt: current.updatedAt,
    };
  }

  if (
    current.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES
    && !input.force
  ) {
    const summary = buildFallbackCheckpointSummary(input);
    return {
      summary,
      summaryBlock: buildCheckpointSummaryBlock(summary, compactedTurnCount),
      compactedTurnCount,
      lastCompactedMessageId: lastHiddenMessageId,
      incremental,
      usedFallback: true,
      consecutiveFailures: current.consecutiveFailures,
      updatedAt: current.updatedAt,
    };
  }

  let summary = current.checkpointSummary;
  let usedFallback = false;
  let consecutiveFailures = current.consecutiveFailures;

  try {
    const generated = await generateCheckpointSummary({
      ...input,
      hiddenTurns: turnsToSummarize,
      existingCheckpointSummary: incremental ? current.checkpointSummary : undefined,
      previousCompactedTurnCount: incremental ? current.compactedTurnCount : undefined,
    });
    summary = generated.summary;
    usedFallback = generated.usedFallback;
    consecutiveFailures = generated.usedFallback
      ? current.consecutiveFailures + 1
      : 0;
  } catch {
    summary = incremental
      ? buildIncrementalFallbackCheckpointSummary({
          existingCheckpointSummary: current.checkpointSummary,
          focusState: input.focusState,
          sessionMemory: input.sessionMemory,
          newHiddenTurns: turnsToSummarize,
        })
      : buildFallbackCheckpointSummary(input);
    usedFallback = true;
    consecutiveFailures = current.consecutiveFailures + 1;
  }

  const nextState = updateSessionCompactionState(input.sessionId, {
    checkpointSummary: summary,
    compactedTurnCount,
    lastCompactedMessageId: lastHiddenMessageId,
    consecutiveFailures,
  });

  return {
    summary,
    summaryBlock: buildCheckpointSummaryBlock(summary, compactedTurnCount),
    compactedTurnCount,
    lastCompactedMessageId: nextState.lastCompactedMessageId,
    incremental,
    usedFallback,
    consecutiveFailures: nextState.consecutiveFailures,
    updatedAt: nextState.updatedAt,
  };
}
