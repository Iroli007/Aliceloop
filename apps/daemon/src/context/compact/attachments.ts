import type { PromptProjectionBlock } from "../promptProjection";

export function buildCompactionBoundaryBlock(input: {
  archivedTurnCount: number;
  keptRecentTurnsCount: number;
  source: "session_memory" | "checkpoint";
}) {
  if (input.archivedTurnCount <= 0) {
    return "";
  }

  const sourceLabel = input.source === "checkpoint"
    ? "checkpoint summary"
    : "rolling session memory";

  return [
    "## Context Boundary",
    "- The raw transcript below starts only after the archived portion described by the summary blocks in this prompt.",
    "- Do not count summary text, carry-forward notes, or checkpoint text as extra user turns.",
    "- Resolve the current reply from the visible raw messages first, then use the archived summary blocks as handoff context.",
    "",
    "<context_boundary>",
    `- Boundary source: ${sourceLabel}`,
    `- Archived turns hidden from raw transcript: ${input.archivedTurnCount}`,
    `- Visible raw turns kept after the boundary: ${input.keptRecentTurnsCount}`,
    "</context_boundary>",
  ].join("\n");
}

export function buildCompactionContextBlocks(input: {
  boundaryBlock: string;
  sessionFocus: string;
  sessionMemoryBlock: string;
  checkpointSummaryBlock: string;
  toolTranscriptBlock: string;
  recentToolActivity: string;
  recentResearchMemory: string;
}): PromptProjectionBlock[] {
  const summaryBlock = input.checkpointSummaryBlock || input.sessionMemoryBlock;

  return [
    { id: "compaction:boundary", content: input.boundaryBlock },
    { id: "compaction:focus", content: input.sessionFocus },
    { id: "compaction:summary", content: summaryBlock },
    {
      id: "compaction:tool-transcript",
      content: input.toolTranscriptBlock || input.recentToolActivity,
    },
    { id: "compaction:research-memory", content: input.recentResearchMemory },
  ].filter((block) => block.content);
}
