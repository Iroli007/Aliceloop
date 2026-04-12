import type { SessionRollingSummary, SessionSnapshot } from "@aliceloop/runtime-core";
import { buildRollingSummaryBlock } from "../session/sessionContext";
import { refreshSessionRollingSummary, resolveRollingSummaryForSnapshot, splitSessionTurns } from "../session/rollingSummary";

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
  summary: SessionRollingSummary;
  block: string;
  archivedTurnCount: number;
  refreshed: boolean;
}> {
  const archivedTurnCount = getArchivedTurnCount(input.snapshot, input.recentTurnsCount);
  const resolved = resolveRollingSummaryForSnapshot(input.snapshot, input.recentTurnsCount);
  const stale = archivedTurnCount > 0
    && (
      input.snapshot.rollingSummary.summarizedTurnCount !== archivedTurnCount
      || !input.snapshot.rollingSummary.summary
    );

  if (!stale || !input.refreshIfStale) {
    return {
      summary: resolved,
      block: buildRollingSummaryBlock(resolved),
      archivedTurnCount,
      refreshed: false,
    };
  }

  const refreshed = await refreshSessionRollingSummary(input.sessionId, input.abortSignal);
  return {
    summary: refreshed,
    block: buildRollingSummaryBlock(refreshed),
    archivedTurnCount,
    refreshed: true,
  };
}
