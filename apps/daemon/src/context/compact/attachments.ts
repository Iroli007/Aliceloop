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
  recentToolActivity: string;
  recentResearchMemory: string;
}) {
  const summaryBlock = input.checkpointSummaryBlock || input.sessionMemoryBlock;

  return [
    input.boundaryBlock,
    input.sessionFocus,
    summaryBlock,
    input.recentToolActivity,
    input.recentResearchMemory,
  ].filter(Boolean);
}
