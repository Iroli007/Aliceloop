import type { SessionMemoryState, SessionSnapshot } from "@aliceloop/runtime-core";
import { getSessionSnapshot, updateSessionMemoryState } from "../../repositories/sessionRepository";
import { refreshSessionRollingSummary, resolveRollingSummaryForSnapshot, splitSessionTurns } from "./rollingSummary";

function createEmptySessionMemory(sessionId: string): SessionMemoryState {
  return {
    sessionId,
    currentPhase: "",
    summary: "",
    completed: [],
    remaining: [],
    decisions: [],
    rememberedTurnCount: 0,
    updatedAt: null,
  };
}

export function rollingSummaryToSessionMemory(input: {
  sessionId: string;
  currentPhase: string;
  summary: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  summarizedTurnCount: number;
  updatedAt: string | null;
}): SessionMemoryState {
  return {
    sessionId: input.sessionId,
    currentPhase: input.currentPhase,
    summary: input.summary,
    completed: [...input.completed],
    remaining: [...input.remaining],
    decisions: [...input.decisions],
    rememberedTurnCount: input.summarizedTurnCount,
    updatedAt: input.updatedAt,
  };
}

export function resolveSessionMemoryForSnapshot(
  snapshot: SessionSnapshot,
  recentTurnsCount: number,
): SessionMemoryState {
  const archivedTurnCount = Math.max(0, splitSessionTurns(snapshot.messages).length - recentTurnsCount);
  if (
    archivedTurnCount > 0
    && snapshot.sessionMemory.rememberedTurnCount === archivedTurnCount
    && snapshot.sessionMemory.summary
  ) {
    return snapshot.sessionMemory;
  }

  const rollingSummary = resolveRollingSummaryForSnapshot(snapshot, recentTurnsCount);
  if (!rollingSummary.summary) {
    return createEmptySessionMemory(snapshot.session.id);
  }

  return rollingSummaryToSessionMemory(rollingSummary);
}

export async function refreshSessionMemory(
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<SessionMemoryState> {
  const snapshot = getSessionSnapshot(sessionId);
  const rollingSummary = await refreshSessionRollingSummary(sessionId, abortSignal);
  const nextMemory = rollingSummaryToSessionMemory(rollingSummary);

  if (
    snapshot.sessionMemory.summary === nextMemory.summary
    && snapshot.sessionMemory.rememberedTurnCount === nextMemory.rememberedTurnCount
    && snapshot.sessionMemory.currentPhase === nextMemory.currentPhase
  ) {
    return snapshot.sessionMemory;
  }

  return updateSessionMemoryState(sessionId, {
    currentPhase: nextMemory.currentPhase,
    summary: nextMemory.summary,
    completed: nextMemory.completed,
    remaining: nextMemory.remaining,
    decisions: nextMemory.decisions,
    rememberedTurnCount: nextMemory.rememberedTurnCount,
  });
}
