import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { Memory } from "@aliceloop/runtime-core";
import { createMemory, listMemoryProjectionRecords, searchMemories, updateMemory } from "../context/memory/memoryRepository";
import {
  curateMemoriesFromTurn,
  type CuratedMemory,
  type ExistingMemoryManifest,
} from "../context/memory/memoryCuratorAgent";
import {
  appendMemoryDailyLog,
  findTopicMemoryManifests,
  listMemoryTopicManifests,
  resolveTopicManifestTarget,
  syncMemoryFileProtocol,
  writeMemoryDailyDreamRollup,
  writeMemoryDreamTrace,
  writeMemoryTopicFile,
} from "../context/memory/memoryFileProtocol";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";
import {
  getSessionMemoryState,
  listSessionEventsSince,
  updateSessionMemoryState,
} from "../repositories/sessionRepository";

const maxSessionMemoryItems = 8;
const maxSessionMemorySummaryChars = 900;
const sessionMemoryInitialTokenThreshold = 10_000;
const sessionMemoryTokenStride = 5_000;
const sessionMemoryToolCallStride = 4;
const autoMemorySubagentType = "coder";
const autoMemoryPersona = "developer";

interface AppliedMemoryAction {
  action: string;
  memoryId: string | null;
  targetMemoryId: string | null;
  title: string | null;
  filePath: string | null;
}

function countApproxTokensFromChars(charCount: number) {
  return Math.ceil(Math.max(0, charCount) / 4);
}

function estimateMessageChars(message: ModelMessage) {
  return typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content).length;
}

function estimateTurnTokens(messages: ModelMessage[], assistantText: string, contextTokenEstimate?: number | null) {
  if (typeof contextTokenEstimate === "number" && Number.isFinite(contextTokenEstimate) && contextTokenEstimate > 0) {
    return Math.ceil(contextTokenEstimate + countApproxTokensFromChars(assistantText.length));
  }

  const messageChars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  return countApproxTokensFromChars(messageChars + assistantText.length);
}

function countCompletedToolCalls(sessionId: string) {
  return listSessionEventsSince(sessionId, 0).filter((event) => event.type === "tool.call.completed").length;
}

function shouldForkSessionMemoryAgent(input: {
  sessionId: string;
  tokenEstimate: number;
  completedToolCallCount: number;
}) {
  const current = getSessionMemoryState(input.sessionId);
  const tokenDelta = input.tokenEstimate - current.lastTokenEstimate;
  const toolCallDelta = input.completedToolCallCount - current.lastToolCallCount;

  if (!current.updatedAt) {
    if (input.tokenEstimate >= sessionMemoryInitialTokenThreshold) {
      return {
        current,
        shouldUpdate: true,
        reason: `initial_token_threshold:${input.tokenEstimate}`,
      };
    }

    if (input.completedToolCallCount >= sessionMemoryToolCallStride) {
      return {
        current,
        shouldUpdate: true,
        reason: `initial_tool_threshold:${input.completedToolCallCount}`,
      };
    }

    return {
      current,
      shouldUpdate: false,
      reason: "below_initial_threshold",
    };
  }

  if (tokenDelta >= sessionMemoryTokenStride) {
    return {
      current,
      shouldUpdate: true,
      reason: `token_stride:${tokenDelta}`,
    };
  }

  if (toolCallDelta >= sessionMemoryToolCallStride) {
    return {
      current,
      shouldUpdate: true,
      reason: `tool_stride:${toolCallDelta}`,
    };
  }

  return {
    current,
    shouldUpdate: false,
    reason: "below_update_threshold",
  };
}

function compactText(value: string | null | undefined, maxLength = 220) {
  const compacted = value?.replace(/\s+/g, " ").trim() ?? "";
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength).trimEnd()}…` : compacted;
}

function formatTemporaryMemory(memory: CuratedMemory) {
  const title = compactText(memory.title, 96);
  const description = compactText(memory.description, 180);
  const content = compactText(memory.content, 220);
  if (title && description && description !== title) {
    return `${title}: ${description}`;
  }
  return title || description || content;
}

function appendUnique(items: string[], additions: string[]) {
  const seen = new Set(items.map((item) => item.toLowerCase()));
  const next = [...items];
  for (const addition of additions) {
    const item = compactText(addition, 220);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    next.push(item);
    seen.add(key);
  }
  return next.slice(-maxSessionMemoryItems);
}

function classifyTemporaryMemory(memory: CuratedMemory) {
  const haystack = `${memory.title ?? ""} ${memory.description ?? ""} ${memory.content}`.toLowerCase();
  if (memory.factKind === "decision" || /decision|decided|决定|决策|采用|改成|不再|只在/.test(haystack)) {
    return "decisions" as const;
  }
  if (/completed|done|finished|implemented|fixed|已完成|完成了|做完|通过|验证/.test(haystack)) {
    return "completed" as const;
  }
  if (/remaining|todo|next|pending|blocked|需要|下一步|待|未完成|继续|还要/.test(haystack)) {
    return "remaining" as const;
  }
  return "summary" as const;
}

function mergeSessionSummary(currentSummary: string, additions: string[]) {
  const nextParts = [currentSummary, ...additions].map((item) => compactText(item, 260)).filter(Boolean);
  const merged = appendUnique([], nextParts).join(" ");
  return merged.length > maxSessionMemorySummaryChars
    ? `${merged.slice(-maxSessionMemorySummaryChars).trimStart()}`
    : merged;
}

function updateSessionMemoryFromTemporaryItems(input: {
  sessionId: string;
  temporary: CuratedMemory[];
  userMessageCount: number;
  tokenEstimate: number;
  completedToolCallCount: number;
  updateReason: string;
}) {
  const { sessionId, temporary, userMessageCount, tokenEstimate, completedToolCallCount, updateReason } = input;
  if (temporary.length === 0) {
    return;
  }

  const current = getSessionMemoryState(sessionId);
  const summaryAdditions: string[] = [];
  const completed: string[] = [];
  const remaining: string[] = [];
  const decisions: string[] = [];

  for (const memory of temporary) {
    const line = formatTemporaryMemory(memory);
    if (!line) {
      continue;
    }

    const bucket = classifyTemporaryMemory(memory);
    if (bucket === "completed") {
      completed.push(line);
    } else if (bucket === "remaining") {
      remaining.push(line);
    } else if (bucket === "decisions") {
      decisions.push(line);
    } else {
      summaryAdditions.push(line);
    }
  }

  const firstTemporary = temporary[0] ?? null;
  const nextCurrentPhase = compactText(firstTemporary?.title ?? firstTemporary?.description ?? firstTemporary?.content, 160) || current.currentPhase;
  updateSessionMemoryState(sessionId, {
    ...current,
    currentPhase: nextCurrentPhase,
    summary: mergeSessionSummary(current.summary, summaryAdditions.length > 0 ? summaryAdditions : temporary.map(formatTemporaryMemory)),
    completed: appendUnique(current.completed, completed),
    remaining: appendUnique(current.remaining, remaining),
    decisions: appendUnique(current.decisions, decisions),
    rememberedTurnCount: Math.max(current.rememberedTurnCount, userMessageCount),
    lastTokenEstimate: tokenEstimate,
    lastToolCallCount: completedToolCallCount,
    lastUpdateReason: updateReason,
    updatedAt: new Date().toISOString(),
  });
}

function recordEmptySessionMemoryAgentRun(input: {
  sessionId: string;
  tokenEstimate: number;
  completedToolCallCount: number;
  updateReason: string;
}) {
  const current = getSessionMemoryState(input.sessionId);
  updateSessionMemoryState(input.sessionId, {
    ...current,
    lastTokenEstimate: input.tokenEstimate,
    lastToolCallCount: input.completedToolCallCount,
    lastUpdateReason: input.updateReason,
    updatedAt: current.updatedAt ?? new Date().toISOString(),
  });
}

async function loadExistingMemoryManifests(queryText: string) {
  const topicManifests = findTopicMemoryManifests(queryText, 5).map((memory): ExistingMemoryManifest => ({
    id: memory.id,
    memoryType: memory.memoryType,
    title: memory.title,
    description: memory.description,
    updatedAt: memory.updatedAt,
  }));
  const manifestsById = new Map(topicManifests.map((memory) => [memory.id, memory]));

  try {
    const result = await searchMemories(queryText, 5, 0);
    for (const memory of result.memories
      .filter((memory) => memory.durability === "permanent" && memory.factState === "active")
      .map((memory): ExistingMemoryManifest => ({
        id: memory.id,
        memoryType: memory.memoryType,
        title: memory.title,
        description: memory.description,
        updatedAt: memory.updatedAt,
      }))) {
      manifestsById.set(memory.id, memory);
    }
  } catch {
    return Array.from(manifestsById.values()).slice(0, 8);
  }

  return Array.from(manifestsById.values()).slice(0, 8);
}

async function applyPermanentMemoryUpdate(memory: CuratedMemory): Promise<AppliedMemoryAction> {
  const targetMemoryId = resolveTopicManifestTarget({
    targetMemoryId: memory.targetMemoryId,
    title: memory.title,
    description: memory.description,
    factKind: memory.factKind,
    factKey: memory.factKey,
  });

  if (memory.action === "noop") {
    return {
      action: memory.action,
      memoryId: null,
      targetMemoryId,
      title: memory.title,
      filePath: null,
    };
  }

  if (memory.action === "retract") {
    let updated: Memory | null = null;
    if (targetMemoryId) {
      updated = await updateMemory(targetMemoryId, {
        factState: "retracted",
      });
    }
    return {
      action: memory.action,
      memoryId: updated?.id ?? null,
      targetMemoryId,
      title: updated?.title ?? memory.title,
      filePath: updated ? writeMemoryTopicFile(updated) : null,
    };
  }

  if ((memory.action === "update" || memory.action === "create") && targetMemoryId) {
    const updated = await updateMemory(targetMemoryId, {
      title: memory.title,
      description: memory.description,
      content: memory.content,
      durability: "permanent",
      memoryType: memory.memoryType,
      factKind: memory.factKind,
      factKey: memory.factKey,
      relatedTopics: memory.relatedTopics,
    });
    return {
      action: "update",
      memoryId: updated?.id ?? null,
      targetMemoryId,
      title: updated?.title ?? memory.title,
      filePath: updated ? writeMemoryTopicFile(updated) : null,
    };
  }

  const created = await createMemory({
    title: memory.title,
    description: memory.description,
    content: memory.content,
    source: "auto",
    durability: "permanent",
    memoryType: memory.memoryType,
    factKind: memory.factKind,
    factKey: memory.factKey,
    relatedTopics: memory.relatedTopics,
  });
  return {
    action: memory.action,
    memoryId: created.id,
    targetMemoryId,
    title: created.title,
    filePath: writeMemoryTopicFile(created),
  };
}

export function schedulePostProcessing(input: {
  sessionId: string;
  messages: ModelMessage[];
  assistantText: string;
  contextTokenEstimate?: number | null;
  publishRuntimeNotice: (sessionId: string, content: string) => void;
}) {
  const userMessages = input.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  const latestUserMessage = userMessages.at(-1) ?? null;

  if (latestUserMessage) {
    void maybeCreateArtifactFromReply(input.sessionId, latestUserMessage, input.assistantText).catch((error) => {
      const detail = error instanceof Error ? error.message : "工件写入失败";
      input.publishRuntimeNotice(input.sessionId, `工件流式写入失败：${detail}`);
    });
  }

  if (!latestUserMessage) {
    return;
  }

  forkSessionMemoryAgent(input.sessionId, async () => {
    const traceId = `memory-dream-${randomUUID()}`;
    const tokenEstimate = estimateTurnTokens(input.messages, input.assistantText, input.contextTokenEstimate);
    const completedToolCallCount = countCompletedToolCalls(input.sessionId);
    const dailyLogPath = appendMemoryDailyLog({
      sessionId: input.sessionId,
      userMessage: latestUserMessage,
      assistantText: input.assistantText,
      tokenEstimate,
      completedToolCallCount,
    });
    const updateDecision = shouldForkSessionMemoryAgent({
      sessionId: input.sessionId,
      tokenEstimate,
      completedToolCallCount,
    });

    const existingMemoryManifests = await loadExistingMemoryManifests(
      [latestUserMessage, input.assistantText].join("\n"),
    );
    const curated = await curateMemoriesFromTurn({
      userMessages,
      assistantResponse: input.assistantText,
      includeSessionMemory: updateDecision.shouldUpdate,
      existingMemoryManifests,
    });

    const appliedActions: AppliedMemoryAction[] = [];
    for (const memory of curated.permanent) {
      try {
        appliedActions.push(await applyPermanentMemoryUpdate(memory));
      } catch {
        // A single fact write should not block the rest of the post-turn updates.
      }
    }

    const fileProtocol = appliedActions.length > 0
      ? syncMemoryFileProtocol(listMemoryProjectionRecords())
      : { indexPath: null, topicPaths: [] as string[] };
    const dailyDreamRollupPath = writeMemoryDailyDreamRollup({
      sessionId: input.sessionId,
      dailyLogPath,
      topicManifests: listMemoryTopicManifests(),
      indexPath: fileProtocol.indexPath,
    });

    if (updateDecision.shouldUpdate) {
      if (curated.temporary.length > 0) {
        updateSessionMemoryFromTemporaryItems({
          sessionId: input.sessionId,
          temporary: curated.temporary,
          userMessageCount: userMessages.length,
          tokenEstimate,
          completedToolCallCount,
          updateReason: updateDecision.reason,
        });
      } else {
        recordEmptySessionMemoryAgentRun({
          sessionId: input.sessionId,
          tokenEstimate,
          completedToolCallCount,
          updateReason: updateDecision.reason,
        });
      }
    }

    writeMemoryDreamTrace({
      traceId,
      sessionId: input.sessionId,
      subagentType: autoMemorySubagentType,
      persona: autoMemoryPersona,
      dailyLogPath,
      existingMemoryManifests,
      curatedMemories: curated.permanent,
      appliedActions,
      indexPath: fileProtocol.indexPath,
      topicPaths: fileProtocol.topicPaths,
      dailyDreamRollupPath,
      sessionMemoryUpdateReason: updateDecision.reason,
    });
  });
}

function forkSessionMemoryAgent(sessionId: string, run: () => Promise<void>) {
  void run().catch((error) => {
    console.warn("[session-memory-agent] failed", {
      sessionId,
      subagentType: autoMemorySubagentType,
      persona: autoMemoryPersona,
      error,
    });
  });
}
