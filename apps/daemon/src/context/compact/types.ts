import type { ModelMessage } from "ai";

export interface CompactionLoadOptions {
  forceCheckpoint?: boolean;
  keepRecentTurnsCount?: number;
  additionalBlocks?: string[];
}

export interface ProjectedModelContext {
  messages: ModelMessage[];
  boundaryBlock: string;
  sessionMemoryBlock: string;
  checkpointSummaryBlock: string;
  toolTranscriptBlock: string;
  usedCheckpoint: boolean;
  usedSessionMemory: boolean;
  boundaryKind: "none" | "session_memory" | "checkpoint";
  boundaryMessageId: string | null;
  keptRecentTurnsCount: number;
  hiddenTurnCount: number;
  timings: Record<string, number | string | null>;
}

export interface CheckpointSummaryResult {
  summary: string;
  summaryBlock: string;
  compactedTurnCount: number;
  lastCompactedMessageId: string | null;
  incremental: boolean;
  usedFallback: boolean;
  consecutiveFailures: number;
  updatedAt: string | null;
}
