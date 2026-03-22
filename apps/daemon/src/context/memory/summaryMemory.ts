import type { MemoryNote, MemoryWithScore } from "@aliceloop/runtime-core";
import { getSessionProjectBinding, listSessionConversationMessages } from "../../repositories/sessionRepository";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";
import { getMemoryConfig } from "./memoryConfig";
import {
  listMemoryNotesBySourcePrefix,
  searchMemories,
  upsertMemoryNote,
} from "./memoryRepository";

const SUMMARY_MEMORY_SOURCE_PREFIX = "summary-memory:";
const GLOBAL_SUMMARY_SOURCE = `${SUMMARY_MEMORY_SOURCE_PREFIX}global`;
const PROJECT_SUMMARY_SOURCE_PREFIX = `${SUMMARY_MEMORY_SOURCE_PREFIX}project:`;
const SUMMARY_MEMORY_ID_PREFIX = "summary-memory";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SUMMARY_MEMORY_LIMIT = parsePositiveInt(process.env.ALICELOOP_SUMMARY_MEMORY_LIMIT, 2);
const SUMMARY_MEMORY_MAX_CHARS = parsePositiveInt(process.env.ALICELOOP_SUMMARY_MEMORY_MAX_CHARS, 1400);
const SUMMARY_REFRESH_MEMORY_LIMIT = parsePositiveInt(process.env.ALICELOOP_SUMMARY_REFRESH_MEMORY_LIMIT, 4);
const SUMMARY_REFRESH_RECENT_MESSAGE_LIMIT = parsePositiveInt(process.env.ALICELOOP_SUMMARY_REFRESH_RECENT_MESSAGE_LIMIT, 6);

export interface SummaryMemoryBlockResult {
  content: string;
  timings: Record<string, number | string | null>;
}

interface SummaryMemoryRecallPrefetch {
  memories: MemoryWithScore[];
  mode: "semantic" | "lexical";
  fallbackReason: string | null;
  skipReason: string | null;
  timings: Record<string, number | string | null>;
}

interface RefreshSummaryMemoryOptions {
  prefetchedRecall?: SummaryMemoryRecallPrefetch | null;
  prefetchedRecallWaitMs?: number | null;
}

function getProjectSummarySource(projectId: string) {
  return `${PROJECT_SUMMARY_SOURCE_PREFIX}${projectId}`;
}

function getProjectSummaryId(projectId: string) {
  return `${SUMMARY_MEMORY_ID_PREFIX}-project-${projectId}`;
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
    `### ${note.title}`,
    `- source: ${note.source}`,
    note.content,
  ].join("\n");
}

function isSummaryMemorySource(source: string | undefined) {
  return Boolean(source?.startsWith(SUMMARY_MEMORY_SOURCE_PREFIX));
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    output.push(line);
  }

  return output;
}

function formatRecentTurnSection(sessionId: string) {
  const recentMessages = listSessionConversationMessages(sessionId, SUMMARY_REFRESH_RECENT_MESSAGE_LIMIT);
  if (recentMessages.length === 0) {
    return "";
  }

  const lines = ["## Recent Signals"];
  for (const message of recentMessages.slice(-4)) {
    const label = message.role === "user" ? "User" : "Assistant";
    lines.push(`- ${label}: ${trimText(message.content, 180)}`);
  }

  return lines.join("\n");
}

function formatMemoryLines(memories: MemoryWithScore[]) {
  if (memories.length === 0) {
    return "";
  }

  const lines = ["## Durable Signals"];
  for (const memory of memories) {
    lines.push(`- ${trimText(memory.content, 220)}`);
  }

  return lines.join("\n");
}

function buildSummaryNoteContent(input: {
  sessionId: string;
  projectName?: string | null;
  projectPath?: string | null;
  userMessage: string;
  assistantResponse: string;
  relevantMemories: MemoryWithScore[];
}) {
  const blocks: string[] = [];

  if (input.projectName || input.projectPath) {
    const lines = ["## Project Context"];
    if (input.projectName) {
      lines.push(`- Project: ${input.projectName}`);
    }
    if (input.projectPath) {
      lines.push(`- Path: ${input.projectPath}`);
    }
    blocks.push(lines.join("\n"));
  }

  const memoryBlock = formatMemoryLines(input.relevantMemories);
  if (memoryBlock) {
    blocks.push(memoryBlock);
  }

  const recentTurn = formatRecentTurnSection(input.sessionId);
  if (recentTurn) {
    blocks.push(recentTurn);
  } else {
    blocks.push([
      "## Recent Signals",
      `- User: ${trimText(input.userMessage, 180)}`,
      `- Assistant: ${trimText(input.assistantResponse, 180)}`,
    ].join("\n"));
  }

  const content = uniqueLines(blocks.join("\n\n").split("\n")).join("\n");
  return trimText(content, SUMMARY_MEMORY_MAX_CHARS);
}

function selectSummaryNotes(sessionId: string) {
  const binding = getSessionProjectBinding(sessionId);
  const notes: MemoryNote[] = [];

  if (binding?.projectId) {
    const projectNote = listMemoryNotesBySourcePrefix(getProjectSummarySource(binding.projectId), 1)[0];
    if (projectNote) {
      notes.push(projectNote);
    }
  }

  const globalNote = listMemoryNotesBySourcePrefix(GLOBAL_SUMMARY_SOURCE, 1)[0];
  if (globalNote) {
    notes.push(globalNote);
  }

  return notes.slice(0, SUMMARY_MEMORY_LIMIT);
}

export function buildSummaryMemoryBlock(sessionId: string): SummaryMemoryBlockResult {
  const startedAt = nowMs();
  const timings: Record<string, number | string | null> = {};

  const notesStartedAt = nowMs();
  const notes = selectSummaryNotes(sessionId);
  timings.noteLookupMs = roundMs(nowMs() - notesStartedAt);
  timings.noteCount = notes.length;

  if (notes.length === 0) {
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const content = [
    "## High-Level Summary Memory",
    "这是异步整理出的高阶记忆摘要，优先用它快速对齐长期偏好、项目约束和最近决定。",
    "",
    ...notes.map((note) => formatSummaryNote(note)),
  ].join("\n");

  timings.totalMs = roundMs(nowMs() - startedAt);
  timings.summaryChars = content.length;

  return {
    content,
    timings,
  };
}

export async function refreshSummaryMemory(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  options: RefreshSummaryMemoryOptions = {},
) {
  const startedAt = nowMs();
  const timings: Record<string, number | string | null> = {};
  const trimmedUserMessage = userMessage.trim();
  const trimmedAssistantResponse = assistantResponse.trim();

  if (!trimmedUserMessage || !trimmedAssistantResponse) {
    return;
  }

  const bindingStartedAt = nowMs();
  const binding = getSessionProjectBinding(sessionId);
  timings.bindingLookupMs = roundMs(nowMs() - bindingStartedAt);

  let relevantMemories: MemoryWithScore[] = [];
  if (options.prefetchedRecall) {
    relevantMemories = options.prefetchedRecall.memories
      .filter((memory) => memory.durability === "permanent")
      .slice(0, SUMMARY_REFRESH_MEMORY_LIMIT);
    timings.prefetchedRecallUsed = 1;
    timings.prefetchedRecallWaitMs = options.prefetchedRecallWaitMs ?? 0;
    timings.prefetchedRecallMode = options.prefetchedRecall.mode;
    timings.prefetchedRecallFallbackReason = options.prefetchedRecall.fallbackReason;
    timings.prefetchedRecallSkipReason = options.prefetchedRecall.skipReason;
    timings.prefetchedRecall = JSON.stringify(options.prefetchedRecall.timings);
    timings.semanticSearchMs = 0;
  } else {
    const semanticStartedAt = nowMs();
    const config = getMemoryConfig();
    relevantMemories = config.enabled
      ? (await searchMemories(trimmedUserMessage, SUMMARY_REFRESH_MEMORY_LIMIT, config.similarityThreshold)).memories
          .filter((memory) => memory.durability === "permanent")
          .slice(0, SUMMARY_REFRESH_MEMORY_LIMIT)
      : [];
    timings.prefetchedRecallUsed = 0;
    timings.semanticSearchMs = roundMs(nowMs() - semanticStartedAt);
  }
  timings.semanticMemoryCount = relevantMemories.length;

  const projectContent = buildSummaryNoteContent({
    sessionId,
    projectName: binding?.projectName ?? null,
    projectPath: binding?.projectPath ?? null,
    userMessage: trimmedUserMessage,
    assistantResponse: trimmedAssistantResponse,
    relevantMemories,
  });

  const now = new Date().toISOString();
  const writeStartedAt = nowMs();
  const writes: string[] = [];

  if (binding?.projectId) {
    upsertMemoryNote({
      id: getProjectSummaryId(binding.projectId),
      kind: "attention-summary",
      title: `项目高阶记忆 · ${binding.projectName ?? binding.projectId}`,
      content: projectContent,
      source: getProjectSummarySource(binding.projectId),
      updatedAt: now,
    });
    writes.push(getProjectSummarySource(binding.projectId));
  } else {
    upsertMemoryNote({
      id: `${SUMMARY_MEMORY_ID_PREFIX}-global`,
      kind: "attention-summary",
      title: "全局高阶记忆",
      content: projectContent,
      source: GLOBAL_SUMMARY_SOURCE,
      updatedAt: now,
    });
    writes.push(GLOBAL_SUMMARY_SOURCE);
  }

  timings.writeMs = roundMs(nowMs() - writeStartedAt);
  timings.summarySources = writes.join(",");
  timings.totalMs = roundMs(nowMs() - startedAt);

  logPerfTrace("summary_memory_refresh", {
    sessionId,
    ...timings,
  });
}

export {
  GLOBAL_SUMMARY_SOURCE,
  PROJECT_SUMMARY_SOURCE_PREFIX,
  SUMMARY_MEMORY_SOURCE_PREFIX,
  isSummaryMemorySource,
};
