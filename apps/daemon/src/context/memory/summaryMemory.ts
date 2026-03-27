import type { MemoryNote } from "@aliceloop/runtime-core";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";
import { listMemoryNotesBySourcePrefix, upsertMemoryNote } from "./memoryRepository";

const SESSION_SUMMARY_SOURCE_PREFIX = "session-summary:";
const SESSION_SUMMARY_ID_PREFIX = "session-summary";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SESSION_SUMMARY_MAX_CHARS = parsePositiveInt(process.env.ALICELOOP_SESSION_SUMMARY_MAX_CHARS, 1400);
const SESSION_SUMMARY_RECENT_ITEM_LIMIT = parsePositiveInt(process.env.ALICELOOP_SESSION_SUMMARY_RECENT_ITEM_LIMIT, 4);

export interface SummaryMemoryBlockResult {
  content: string;
  timings: Record<string, number | string | null>;
}

export interface SessionSummaryItem {
  content: string;
  relatedTopics?: string[];
}

function getSessionSummarySource(sessionId: string) {
  return `${SESSION_SUMMARY_SOURCE_PREFIX}${sessionId}`;
}

function getSessionSummaryId(sessionId: string) {
  return `${SESSION_SUMMARY_ID_PREFIX}-${sessionId}`;
}

function trimText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function formatSummaryNote(note: MemoryNote) {
  return [
    "## Session Summary",
    note.content,
  ].join("\n");
}

function selectSessionSummaryNote(sessionId: string) {
  return listMemoryNotesBySourcePrefix(getSessionSummarySource(sessionId), 1)[0] ?? null;
}

export function buildSummaryMemoryBlock(sessionId: string): SummaryMemoryBlockResult {
  const startedAt = nowMs();
  const timings: Record<string, number | string | null> = {};

  const notesStartedAt = nowMs();
  const note = selectSessionSummaryNote(sessionId);
  timings.noteLookupMs = roundMs(nowMs() - notesStartedAt);
  timings.noteCount = note ? 1 : 0;

  if (!note) {
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const content = formatSummaryNote(note);
  timings.totalMs = roundMs(nowMs() - startedAt);
  timings.summaryChars = content.length;

  return {
    content,
    timings,
  };
}

function formatTemporaryItems(items: SessionSummaryItem[]) {
  const lines = items.slice(0, SESSION_SUMMARY_RECENT_ITEM_LIMIT)
    .map((item) => trimText(item.content, 220))
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return [
    "## Temporary Preferences",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

function buildSessionSummaryContent(input: {
  userMessage: string;
  assistantResponse: string;
  temporaryItems: SessionSummaryItem[];
}) {
  const blocks: string[] = [];

  const topicSummary = [
    "## Current Topic Summary",
    `- User: ${trimText(input.userMessage, 240)}`,
    `- Assistant: ${trimText(input.assistantResponse, 320)}`,
  ].join("\n");
  blocks.push(topicSummary);

  const temporaryBlock = formatTemporaryItems(input.temporaryItems);
  if (temporaryBlock) {
    blocks.push(temporaryBlock);
  }

  const conclusion = trimText(input.assistantResponse, 320);
  if (conclusion) {
    blocks.push([
      "## Current Conclusions",
      `- ${conclusion}`,
    ].join("\n"));
  }

  const content = blocks.join("\n\n");
  return trimText(content, SESSION_SUMMARY_MAX_CHARS);
}

export async function refreshSummaryMemory(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  options: {
    temporaryItems?: SessionSummaryItem[];
  } = {},
) {
  const startedAt = nowMs();
  const timings: Record<string, number | string | null> = {};
  const trimmedUserMessage = userMessage.trim();
  const trimmedAssistantResponse = assistantResponse.trim();

  if (!trimmedUserMessage || !trimmedAssistantResponse) {
    return;
  }

  const content = buildSessionSummaryContent({
    userMessage: trimmedUserMessage,
    assistantResponse: trimmedAssistantResponse,
    temporaryItems: options.temporaryItems ?? [],
  });

  const now = new Date().toISOString();
  const writeStartedAt = nowMs();
  upsertMemoryNote({
    id: getSessionSummaryId(sessionId),
    kind: "attention-summary",
    title: "会话摘要",
    content,
    source: getSessionSummarySource(sessionId),
    updatedAt: now,
  });
  timings.writeMs = roundMs(nowMs() - writeStartedAt);
  timings.summarySources = getSessionSummarySource(sessionId);
  timings.totalMs = roundMs(nowMs() - startedAt);

  logPerfTrace("session_summary_refresh", {
    sessionId,
    ...timings,
  });
}

export {
  SESSION_SUMMARY_SOURCE_PREFIX,
  getSessionSummarySource,
  getSessionSummaryId,
};
