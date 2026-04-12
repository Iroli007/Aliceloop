import { generateText } from "ai";
import { z } from "zod";
import type { SessionMessage, SessionRollingSummary, SessionSnapshot } from "@aliceloop/runtime-core";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";
import { getRuntimeSettings } from "../../repositories/runtimeSettingsRepository";
import { getSessionSnapshot, updateSessionRollingSummary } from "../../repositories/sessionRepository";

export interface SessionTurn {
  index: number;
  userMessage: SessionMessage | null;
  assistantMessages: SessionMessage[];
  messages: SessionMessage[];
}

const rollingSummarySchema = z.object({
  currentPhase: z.string().trim().max(120).default(""),
  summary: z.string().trim().min(1).max(900),
  completed: z.array(z.string().trim().min(1).max(180)).max(6).default([]),
  remaining: z.array(z.string().trim().min(1).max(180)).max(6).default([]),
  decisions: z.array(z.string().trim().min(1).max(180)).max(6).default([]),
});

type RollingSummaryDraft = z.infer<typeof rollingSummarySchema>;

function extractSummaryJson(text: string) {
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  const payload = summaryMatch?.[1]?.trim() || text.trim();
  if (!payload) {
    return null;
  }

  try {
    return rollingSummarySchema.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}

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

function isMeaningfulMessage(message: SessionMessage) {
  return message.role !== "system";
}

function summarizeMessage(message: SessionMessage, maxChars: number) {
  return trimInline(message.content, maxChars);
}

function summarizeTurnHeadline(turn: SessionTurn) {
  if (turn.userMessage) {
    return summarizeMessage(turn.userMessage, 72);
  }

  const assistantMessage = turn.assistantMessages.at(-1);
  return assistantMessage ? summarizeMessage(assistantMessage, 72) : "";
}

function formatTurnsForPrompt(turns: SessionTurn[]) {
  const lines: string[] = [];

  for (const turn of turns) {
    lines.push(`Turn ${turn.index}`);
    for (const message of turn.messages) {
      const label = message.role === "assistant" ? "Assistant" : "User";
      lines.push(`${label}: ${summarizeMessage(message, 280)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildFallbackRollingSummary(archivedTurns: SessionTurn[]): RollingSummaryDraft {
  const firstTurn = archivedTurns[0] ?? null;
  const latestTurn = archivedTurns.at(-1) ?? null;
  const assistantHighlights = archivedTurns
    .flatMap((turn) => turn.assistantMessages)
    .map((message) => summarizeMessage(message, 160))
    .filter(Boolean)
    .slice(-3);
  const latestTurnEndedWithUser = latestTurn?.messages.at(-1)?.role === "user";

  const summaryParts = [
    `Archived ${archivedTurns.length} earlier turns.`,
    firstTurn ? `Started with: ${summarizeTurnHeadline(firstTurn)}.` : "",
    latestTurn ? `Most recent archived turn: ${summarizeTurnHeadline(latestTurn)}.` : "",
  ].filter(Boolean);

  return {
    currentPhase: latestTurn ? summarizeTurnHeadline(latestTurn) : "",
    summary: summaryParts.join(" "),
    completed: assistantHighlights,
    remaining: latestTurn && latestTurnEndedWithUser ? [summarizeTurnHeadline(latestTurn)] : [],
    decisions: [],
  };
}

function createEmptyRollingSummary(sessionId: string): SessionRollingSummary {
  return {
    sessionId,
    currentPhase: "",
    summary: "",
    completed: [],
    remaining: [],
    decisions: [],
    summarizedTurnCount: 0,
    updatedAt: null,
  };
}

async function generateRollingSummaryDraft(input: {
  existingSummary: SessionRollingSummary | null;
  archivedTurns: SessionTurn[];
  allArchivedTurns: SessionTurn[];
  abortSignal?: AbortSignal;
}) {
  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    return buildFallbackRollingSummary(input.allArchivedTurns);
  }

  const existingSummary = input.existingSummary;
  const prompt = existingSummary
    ? [
        "CRITICAL: Respond with TEXT ONLY.",
        "Do NOT call tools.",
        "Return exactly one <analysis> block followed by one <summary> block.",
        "The <summary> block must contain valid JSON matching this shape:",
        "{\"currentPhase\":\"string\",\"summary\":\"string\",\"completed\":[\"string\"],\"remaining\":[\"string\"],\"decisions\":[\"string\"]}",
        "",
        "Update the rolling thread summary for a long-running work session.",
        "The existing summary already covers earlier archived turns. Extend it with the newly archived turns below.",
        "Keep the summary concise and operational.",
        "Focus on the current phase, completed work, remaining work, and locked-in decisions.",
        "Return short bullet-friendly strings. Do not mention turn numbers in the final output.",
        "",
        "Existing rolling summary:",
        `Current phase: ${existingSummary.currentPhase || "(empty)"}`,
        `Summary: ${existingSummary.summary || "(empty)"}`,
        `Completed: ${existingSummary.completed.join(" | ") || "(empty)"}`,
        `Remaining: ${existingSummary.remaining.join(" | ") || "(empty)"}`,
        `Decisions: ${existingSummary.decisions.join(" | ") || "(empty)"}`,
        "",
        "Newly archived turns:",
        formatTurnsForPrompt(input.archivedTurns),
      ].join("\n")
    : [
        "CRITICAL: Respond with TEXT ONLY.",
        "Do NOT call tools.",
        "Return exactly one <analysis> block followed by one <summary> block.",
        "The <summary> block must contain valid JSON matching this shape:",
        "{\"currentPhase\":\"string\",\"summary\":\"string\",\"completed\":[\"string\"],\"remaining\":[\"string\"],\"decisions\":[\"string\"]}",
        "",
        "Summarize the archived portion of a long-running work session.",
        "Extract the current phase, a compact rolling summary, completed work, remaining work, and decisions.",
        "Keep everything concise and operational.",
        "Return short bullet-friendly strings. Do not restate the full transcript.",
        "",
        "Archived turns:",
        formatTurnsForPrompt(input.archivedTurns),
      ].join("\n");

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      abortSignal: input.abortSignal,
      temperature: 0.2,
      prompt,
    });
    return extractSummaryJson(response.text) ?? buildFallbackRollingSummary(input.allArchivedTurns);
  } catch {
    return buildFallbackRollingSummary(input.allArchivedTurns);
  }
}

function isEmptyRollingSummary(summary: SessionRollingSummary) {
  return (
    !summary.currentPhase
    && !summary.summary
    && summary.completed.length === 0
    && summary.remaining.length === 0
    && summary.decisions.length === 0
    && summary.summarizedTurnCount === 0
  );
}

export function splitSessionTurns(messages: SessionMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let currentTurn: SessionTurn | null = null;

  for (const message of messages.filter(isMeaningfulMessage)) {
    if (message.role === "user" || !currentTurn) {
      currentTurn = {
        index: turns.length + 1,
        userMessage: message.role === "user" ? message : null,
        assistantMessages: message.role === "assistant" ? [message] : [],
        messages: [message],
      };
      turns.push(currentTurn);
      continue;
    }

    currentTurn.messages.push(message);
    if (message.role === "assistant") {
      currentTurn.assistantMessages.push(message);
    }
  }

  return turns;
}

export function listRecentTurnMessages(
  messages: SessionMessage[],
  recentTurnsCount = getRuntimeSettings().recentTurnsCount,
) {
  const turns = splitSessionTurns(messages);
  if (turns.length <= recentTurnsCount) {
    return messages.filter(isMeaningfulMessage);
  }

  return turns
    .slice(-recentTurnsCount)
    .flatMap((turn) => turn.messages);
}

export function resolveRollingSummaryForSnapshot(
  snapshot: SessionSnapshot,
  recentTurnsCount = getRuntimeSettings().recentTurnsCount,
): SessionRollingSummary {
  const turns = splitSessionTurns(snapshot.messages);
  const archivedTurnCount = Math.max(0, turns.length - recentTurnsCount);
  if (archivedTurnCount === 0) {
    return createEmptyRollingSummary(snapshot.session.id);
  }

  if (snapshot.rollingSummary.summarizedTurnCount === archivedTurnCount && snapshot.rollingSummary.summary) {
    return snapshot.rollingSummary;
  }

  const archivedTurns = turns.slice(0, archivedTurnCount);
  const draft = buildFallbackRollingSummary(archivedTurns);
  return {
    sessionId: snapshot.session.id,
    currentPhase: draft.currentPhase,
    summary: draft.summary,
    completed: draft.completed,
    remaining: draft.remaining,
    decisions: draft.decisions,
    summarizedTurnCount: archivedTurnCount,
    updatedAt: snapshot.rollingSummary.updatedAt,
  };
}

export async function refreshSessionRollingSummary(
  sessionId: string,
  abortSignal?: AbortSignal,
) {
  const snapshot = getSessionSnapshot(sessionId);
  const turns = splitSessionTurns(snapshot.messages);
  const recentTurnsCount = getRuntimeSettings().recentTurnsCount;
  const archivedTurnCount = Math.max(0, turns.length - recentTurnsCount);
  const archivedTurns = archivedTurnCount > 0 ? turns.slice(0, archivedTurnCount) : [];
  const current = snapshot.rollingSummary;

  if (archivedTurns.length === 0) {
    if (isEmptyRollingSummary(current)) {
      return current;
    }

    return updateSessionRollingSummary(sessionId, {
      currentPhase: "",
      summary: "",
      completed: [],
      remaining: [],
      decisions: [],
      summarizedTurnCount: 0,
    });
  }

  const shouldRebuild = current.summarizedTurnCount < 1 || current.summarizedTurnCount > archivedTurns.length || !current.summary;
  const unsummarizedTurns = shouldRebuild ? archivedTurns : archivedTurns.slice(current.summarizedTurnCount);

  if (!shouldRebuild && unsummarizedTurns.length === 0) {
    return current;
  }

  const draft = await generateRollingSummaryDraft({
    existingSummary: shouldRebuild ? null : current,
    archivedTurns: unsummarizedTurns,
    allArchivedTurns: archivedTurns,
    abortSignal,
  });

  return updateSessionRollingSummary(sessionId, {
    currentPhase: draft.currentPhase,
    summary: draft.summary,
    completed: draft.completed,
    remaining: draft.remaining,
    decisions: draft.decisions,
    summarizedTurnCount: archivedTurns.length,
  });
}
