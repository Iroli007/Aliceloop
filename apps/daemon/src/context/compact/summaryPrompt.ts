import type { SessionFocusState, SessionRollingSummary } from "@aliceloop/runtime-core";
import type { SessionTurn } from "../session/rollingSummary";

const NO_TOOLS_PREAMBLE = [
  "CRITICAL: Respond with TEXT ONLY.",
  "Do NOT call tools.",
  "Do NOT emit JSON.",
  "Your entire response must be exactly one <analysis> block followed by one <summary> block.",
].join("\n");

function normalizeInline(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function trimInline(content: string, maxChars: number) {
  const normalized = normalizeInline(content);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function formatTurns(turns: SessionTurn[]) {
  return turns
    .map((turn) => {
      const lines = [`Turn ${turn.index}`];
      for (const message of turn.messages) {
        const role = message.role === "assistant" ? "Assistant" : "User";
        lines.push(`${role}: ${trimInline(message.content, 420)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatSessionMemory(summary: SessionRollingSummary) {
  return [
    `Current phase: ${summary.currentPhase || "(empty)"}`,
    `Summary: ${summary.summary || "(empty)"}`,
    `Completed: ${summary.completed.join(" | ") || "(empty)"}`,
    `Remaining: ${summary.remaining.join(" | ") || "(empty)"}`,
    `Decisions: ${summary.decisions.join(" | ") || "(empty)"}`,
    `Archived turns covered: ${summary.summarizedTurnCount}`,
  ].join("\n");
}

function formatFocus(focusState: SessionFocusState) {
  return [
    `Goal: ${focusState.goal || "(empty)"}`,
    `Constraints: ${focusState.constraints.join(" | ") || "(empty)"}`,
    `Priorities: ${focusState.priorities.join(" | ") || "(empty)"}`,
    `Next step: ${focusState.nextStep || "(empty)"}`,
    `Done criteria: ${focusState.doneCriteria.join(" | ") || "(empty)"}`,
    `Blockers: ${focusState.blockers.join(" | ") || "(empty)"}`,
  ].join("\n");
}

export function buildCheckpointSummaryPrompt(input: {
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  hiddenTurns: SessionTurn[];
  keptRecentTurnsCount: number;
}) {
  return [
    NO_TOOLS_PREAMBLE,
    "",
    "You are creating a checkpoint summary for a long-running coding thread.",
    "The raw messages for earlier turns will be removed from the model-visible context.",
    "Write a precise handoff for the next model so it can continue the work without repeating already-completed steps.",
    "",
    "In <analysis>, reason through the hidden turns chronologically and identify what changed, what matters, and what should not be repeated.",
    "In <summary>, produce a concise but high-signal handoff with these sections:",
    "1. Primary request",
    "2. Current focus and constraints",
    "3. Important files, tools, or artifacts",
    "4. Progress and decisions",
    "5. Errors or failed attempts",
    "6. Pending work",
    "7. Immediate next step",
    "",
    "Keep the <summary> operational. Do not include chain-of-thought there.",
    `The model will still see the most recent ${input.keptRecentTurnsCount} raw turns after this checkpoint.`,
    "",
    "## Session Focus",
    formatFocus(input.focusState),
    "",
    "## Session Memory",
    formatSessionMemory(input.sessionMemory),
    "",
    "## Hidden Turns To Checkpoint",
    formatTurns(input.hiddenTurns),
  ].join("\n");
}

export function buildIncrementalCheckpointSummaryPrompt(input: {
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  existingCheckpointSummary: string;
  previousCompactedTurnCount: number;
  newHiddenTurns: SessionTurn[];
  keptRecentTurnsCount: number;
}) {
  return [
    NO_TOOLS_PREAMBLE,
    "",
    "You are updating an existing checkpoint summary for a long-running coding thread.",
    "The previously hidden turns remain unchanged. Only the newly hidden turns below need to be merged into the checkpoint.",
    "Preserve the important context from the existing checkpoint summary, fold in the new hidden turns, and avoid duplicating points that are already captured.",
    "",
    "In <analysis>, compare the existing checkpoint summary with the newly hidden turns and identify what changed.",
    "In <summary>, return a refreshed full checkpoint handoff with these sections:",
    "1. Primary request",
    "2. Current focus and constraints",
    "3. Important files, tools, or artifacts",
    "4. Progress and decisions",
    "5. Errors or failed attempts",
    "6. Pending work",
    "7. Immediate next step",
    "",
    "Keep the <summary> operational. Do not include chain-of-thought there.",
    `The existing checkpoint summary currently covers ${input.previousCompactedTurnCount} hidden turns.`,
    `The model will still see the most recent ${input.keptRecentTurnsCount} raw turns after this checkpoint.`,
    "",
    "## Existing Checkpoint Summary",
    input.existingCheckpointSummary.trim() || "(empty)",
    "",
    "## Session Focus",
    formatFocus(input.focusState),
    "",
    "## Session Memory",
    formatSessionMemory(input.sessionMemory),
    "",
    "## Newly Hidden Turns To Merge",
    formatTurns(input.newHiddenTurns),
  ].join("\n");
}

export function extractSummaryFromXml(text: string) {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return match?.[1]?.trim() || "";
}

export function buildFallbackCheckpointSummary(input: {
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  hiddenTurns: SessionTurn[];
}) {
  const latestHiddenTurn = input.hiddenTurns.at(-1);
  const latestUserHeadline = latestHiddenTurn?.userMessage
    ? trimInline(latestHiddenTurn.userMessage.content, 140)
    : "";
  const latestAssistantHighlights = latestHiddenTurn?.assistantMessages
    .map((message) => trimInline(message.content, 160))
    .filter(Boolean)
    .slice(-2) ?? [];

  return [
    `Primary request: ${input.focusState.goal || input.sessionMemory.summary || "Continue the active session without losing prior work."}`,
    `Current focus and constraints: ${(input.focusState.priorities.join(" | ") || input.focusState.constraints.join(" | ") || input.sessionMemory.currentPhase || "Keep continuity with the current thread state.")}`,
    `Progress and decisions: ${(input.sessionMemory.completed.join(" | ") || input.sessionMemory.decisions.join(" | ") || "Earlier work has already been summarized into session memory.")}`,
    ...(latestAssistantHighlights.length > 0 ? [`Recent hidden progress: ${latestAssistantHighlights.join(" | ")}`] : []),
    ...(latestUserHeadline ? [`Pending work: ${latestUserHeadline}`] : []),
    `Immediate next step: ${input.focusState.nextStep || input.sessionMemory.remaining[0] || "Continue from the latest visible turn without restarting the thread."}`,
  ].join("\n");
}

export function buildIncrementalFallbackCheckpointSummary(input: {
  existingCheckpointSummary: string;
  focusState: SessionFocusState;
  sessionMemory: SessionRollingSummary;
  newHiddenTurns: SessionTurn[];
}) {
  const latestHiddenTurn = input.newHiddenTurns.at(-1);
  const latestUserHeadline = latestHiddenTurn?.userMessage
    ? trimInline(latestHiddenTurn.userMessage.content, 140)
    : "";
  const latestAssistantHighlights = input.newHiddenTurns
    .flatMap((turn) => turn.assistantMessages)
    .map((message) => trimInline(message.content, 160))
    .filter(Boolean)
    .slice(-3);

  return [
    input.existingCheckpointSummary.trim(),
    ...(latestAssistantHighlights.length > 0 ? [`Recent hidden progress: ${latestAssistantHighlights.join(" | ")}`] : []),
    ...(latestUserHeadline ? [`Updated pending work: ${latestUserHeadline}`] : []),
    `Immediate next step: ${input.focusState.nextStep || input.sessionMemory.remaining[0] || "Continue from the latest visible turn without restarting the thread."}`,
  ].filter(Boolean).join("\n");
}

export function buildCheckpointSummaryBlock(summary: string, compactedTurnCount: number) {
  if (!summary.trim()) {
    return "";
  }

  return [
    "## Context Checkpoint",
    "- Treat this as the handoff summary for earlier turns that are no longer present as raw messages.",
    "- Continue from this checkpoint instead of restarting the thread from zero.",
    "",
    "<checkpoint_summary>",
    summary.trim(),
    `Archived turns covered: ${compactedTurnCount}`,
    "</checkpoint_summary>",
  ].join("\n");
}
