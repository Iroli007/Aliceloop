import type { SessionMemoryState, SessionSnapshot } from "@aliceloop/runtime-core";
import { buildSessionMemoryBlock } from "../session/sessionContext";
import { splitSessionTurns } from "../session/rollingSummary";
import { refreshSessionMemory, resolveSessionMemoryForSnapshot } from "../session/sessionMemory";

export function getArchivedTurnCount(snapshot: SessionSnapshot, recentTurnsCount: number) {
  const turns = splitSessionTurns(snapshot.messages);
  return Math.max(0, turns.length - recentTurnsCount);
}

export async function ensureSessionMemoryFresh(input: {
  sessionId: string;
  snapshot: SessionSnapshot;
  recentTurnsCount: number;
  abortSignal?: AbortSignal;
  refreshIfStale: boolean;
}): Promise<{
  summary: SessionMemoryState;
  block: string;
  archivedTurnCount: number;
  refreshed: boolean;
}> {
  const archivedTurnCount = getArchivedTurnCount(input.snapshot, input.recentTurnsCount);
  const resolved = resolveSessionMemoryForSnapshot(input.snapshot, input.recentTurnsCount);
  const stale = archivedTurnCount > 0
    && (
      input.snapshot.sessionMemory.rememberedTurnCount !== archivedTurnCount
      || !input.snapshot.sessionMemory.summary
    );

  if (!stale || !input.refreshIfStale) {
    return {
      summary: resolved,
      block: buildSessionMemoryBlock(resolved),
      archivedTurnCount,
      refreshed: false,
    };
  }

  const refreshed = await refreshSessionMemory(input.sessionId, input.abortSignal);
  return {
    summary: refreshed,
    block: buildSessionMemoryBlock(refreshed),
    archivedTurnCount,
    refreshed: true,
  };
}
