import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import type { LanguageModelUsage } from "ai";
import type { AgentContext } from "../context/index";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  createSessionMessage,
  updateSessionMessage,
} from "../repositories/sessionRepository";
import { listProviderReasoningTracesForToolCalls } from "../repositories/providerReasoningRepository";
import { syncSessionProjectHistory } from "../services/sessionProjectService";
import { getRenderableAssistantText } from "./providerRuntimeAdapter";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
import { finalizePromptCacheRunTrace, type PromptCacheRunTrace } from "./promptCacheTelemetry";
import { clearStreamCheckpoint, saveStreamCheckpoint } from "./streamCheckpoint";
import type { ToolStateMachine } from "./toolStateMachine";

const DEBOUNCE_MS = 80;

function buildProcessedReasoningPayload(input: {
  sessionId: string;
  providerId: string;
  stateMachine: ToolStateMachine;
}) {
  const toolCallIds = input.stateMachine.getAll().map((state) => state.toolCallId);
  const traces = listProviderReasoningTracesForToolCalls({
    sessionId: input.sessionId,
    providerId: input.providerId,
    toolCallIds,
  });

  if (traces.length === 0) {
    return null;
  }

  return {
    status: "processed",
    kind: input.providerId === "deepseek" ? "deepseek-thinking" : "provider-thinking",
    label: "已处理",
    traceCount: traces.length,
    summary: "思考内容已处理并用于后续工具调用。",
  };
}

interface TextStreamLike {
  textStream: AsyncIterable<string>;
  toolCalls: PromiseLike<unknown[]>;
  providerMetadata: PromiseLike<{
    anthropic?: {
      cacheCreationInputTokens?: unknown;
      cacheReadInputTokens?: unknown;
    };
  } | undefined>;
  totalUsage?: PromiseLike<LanguageModelUsage>;
}

interface TextFallbackResult {
  replacementText: string;
  toolCallCount: number;
}

interface ToolResultSummaryResult {
  replacementText: string;
}

function mergeEventPayload(...parts: Array<Record<string, unknown> | undefined>) {
  const merged = Object.assign({}, ...parts.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

interface ConsumeTextStreamInput {
  sessionId: string;
  providerId: string;
  context: AgentContext;
  stream: TextStreamLike;
  stateMachine: ToolStateMachine;
  reasoningEffort: ReasoningEffort;
  requestStartedAt: number;
  existingAssistantMessageId: string | null;
  initialText?: string;
  checkActive(): void;
  summarizeUnknown(value: unknown, maxLength?: number): string | null;
  resolveTextFallback(input: {
    assistantText: string;
    stateMachine: ToolStateMachine;
    reasoningEffort: ReasoningEffort;
  }): Promise<TextFallbackResult | null>;
  resolveToolResultSummary(input: {
    assistantText: string;
    resolvedToolCalls: unknown[];
    stateMachine: ToolStateMachine;
    reasoningEffort: ReasoningEffort;
  }): Promise<ToolResultSummaryResult | null>;
}

export async function consumeTextStream(input: ConsumeTextStreamInput): Promise<{
  text: string;
  assistantMessageId: string | null;
  timings: Record<string, number | null>;
  diagnostics: {
    resolvedToolCallCount: number;
    providerMetadataPreview: string | null;
    promptCache: PromptCacheRunTrace | null;
  };
}> {
  let text = input.initialText ?? "";
  const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
  let assistantMessageId: string | null = input.existingAssistantMessageId;
  let pendingFlush = false;
  let pendingDelta = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTokenMs: number | null = null;
  let resolvedToolCalls: unknown[] = [];
  let fallbackToolCallCount = 0;
  const assistantEventPayload = input.context.displayMemories.length > 0 || input.context.displaySkillIds.length > 0
    ? {
        memories: input.context.displayMemories,
        skills: input.context.displaySkillIds,
      }
    : undefined;
  const processingEventPayload = mergeEventPayload(assistantEventPayload, { displayMode: "processing" });

  function getChatContent(final = false) {
    return getRenderableAssistantText(input.providerId, text, final);
  }

  let publishedContent = getChatContent() ?? "";

  function ensureAssistantMessage(content: string, allowEmpty = false) {
    if (assistantMessageId) {
      return true;
    }
    if (!allowEmpty && !content && !publishedContent) {
      return false;
    }

    if (content || publishedContent) {
      firstTokenMs ??= roundMs(nowMs() - input.requestStartedAt);
    }
    const messageResult = createSessionMessage({
      sessionId: input.sessionId,
      clientMessageId: assistantClientMessageId,
      deviceId: "runtime-agent",
      role: "assistant",
      content: publishedContent,
      attachmentIds: [],
      eventPayload: processingEventPayload,
    });

    assistantMessageId = messageResult.message.id;
    saveStreamCheckpoint(input.sessionId, assistantMessageId, text);
    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }
    return true;
  }

  function queueContent(content: string) {
    if (content === publishedContent) {
      return false;
    }

    const delta = content.startsWith(publishedContent)
      ? content.slice(publishedContent.length)
      : content;
    publishedContent = content;
    pendingDelta += delta;
    pendingFlush = true;
    return true;
  }

  function flush() {
    if (!assistantMessageId || !pendingFlush) return;
    pendingFlush = false;
    const delta = pendingDelta;
    pendingDelta = "";
    const updateResult = updateSessionMessage({
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      content: publishedContent,
      eventType: "message.delta",
      eventPayload: {
        ...(processingEventPayload ?? {}),
        delta,
      },
    });
    publishSessionEvent(updateResult.event);
  }

  ensureAssistantMessage("", true);

  for await (const delta of input.stream.textStream) {
    input.checkActive();
    if (!delta) continue;

    text += delta;
    const content = getChatContent();
    if (content === null || !content) {
      continue;
    }
    firstTokenMs ??= roundMs(nowMs() - input.requestStartedAt);

    if (!ensureAssistantMessage(content)) {
      continue;
    }

    if (assistantMessageId) {
      saveStreamCheckpoint(input.sessionId, assistantMessageId, text);
    }

    if (!queueContent(content)) {
      continue;
    }

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flush();
        flushTimer = null;
      }, DEBOUNCE_MS);
    }
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingFlush) flush();

  resolvedToolCalls = await input.stream.toolCalls;
  const streamedText = text;

  if (resolvedToolCalls.length === 0 && text.trim()) {
    const fallback = await input.resolveTextFallback({
      assistantText: text,
      stateMachine: input.stateMachine,
      reasoningEffort: input.reasoningEffort,
    });

    if (fallback) {
      fallbackToolCallCount = fallback.toolCallCount;
      text = fallback.replacementText;
    }
  }

  const resolvedToolCallCount = Array.isArray(resolvedToolCalls)
    ? resolvedToolCalls.length + fallbackToolCallCount
    : fallbackToolCallCount;
  const hasToolWork = resolvedToolCallCount > 0 || input.stateMachine.getAll().length > 0;

  if (hasToolWork) {
    const summary = await input.resolveToolResultSummary({
      assistantText: streamedText,
      resolvedToolCalls,
      stateMachine: input.stateMachine,
      reasoningEffort: input.reasoningEffort,
    });
    text = summary?.replacementText.trim() || text.trim() || `已完成 ${resolvedToolCallCount} 次工具调用。`;
  }

  const finalContent = getChatContent(true);
  const reasoning = buildProcessedReasoningPayload({
    sessionId: input.sessionId,
    providerId: input.providerId,
    stateMachine: input.stateMachine,
  });

  if (assistantMessageId) {
    const processingCompleted = updateSessionMessage({
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      content: publishedContent,
      eventType: "message.completed",
      eventPayload: mergeEventPayload(processingEventPayload, reasoning ? { reasoning } : undefined),
    });
    publishSessionEvent(processingCompleted.event);

    if (typeof finalContent === "string" && finalContent.trim()) {
      const messageResult = createSessionMessage({
        sessionId: input.sessionId,
        clientMessageId: `agent-final-${randomUUID()}`,
        deviceId: "runtime-agent",
        role: "assistant",
        content: finalContent,
        attachmentIds: [],
        eventPayload: assistantEventPayload,
      });

      assistantMessageId = messageResult.message.id;
      for (const event of messageResult.events) {
        publishSessionEvent(event);
      }

      const completedResult = updateSessionMessage({
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        content: finalContent,
        eventType: "message.completed",
        eventPayload: mergeEventPayload(assistantEventPayload, { displayMode: "final" }, reasoning ? { reasoning } : undefined),
      });
      publishSessionEvent(completedResult.event);
    }

    await syncSessionProjectHistory(input.sessionId);
    clearStreamCheckpoint(input.sessionId);
  }

  const metadata = await input.stream.providerMetadata;
  const totalUsage = input.stream.totalUsage
    ? await Promise.resolve(input.stream.totalUsage).catch(() => undefined)
    : undefined;
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  if (metadata?.anthropic) {
    cacheCreationInputTokens = typeof metadata.anthropic.cacheCreationInputTokens === "number"
      ? metadata.anthropic.cacheCreationInputTokens
      : null;
    cacheReadInputTokens = typeof metadata.anthropic.cacheReadInputTokens === "number"
      ? metadata.anthropic.cacheReadInputTokens
      : null;
    if (cacheCreationInputTokens || cacheReadInputTokens) {
      console.log(`[Cache] write=${cacheCreationInputTokens ?? 0} read=${cacheReadInputTokens ?? 0}`);
    }
  }

  const promptCache = finalizePromptCacheRunTrace(
    input.sessionId,
    input.context.promptCacheTrace,
    {
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
  );

  logPerfTrace("prompt_cache", {
    sessionId: input.sessionId,
    providerId: input.providerId,
    requestHash: promptCache.requestHash,
    breakpoints: promptCache.breakpoints.map((breakpoint) => ({
      id: breakpoint.id,
      stage: breakpoint.stage,
      marker: breakpoint.marker,
      prefixHash: breakpoint.prefixHash,
      prefixChars: breakpoint.prefixChars,
    })),
    stableBreakpointIdsVsPrevious: promptCache.stableBreakpointIdsVsPrevious,
    likelyHitBreakpointIds: promptCache.likelyHitBreakpointIds,
    likelyMissBreakpointIds: promptCache.likelyMissBreakpointIds,
    highestStableBreakpointId: promptCache.highestStableBreakpointId,
    cacheCreationInputTokens: promptCache.cacheCreationInputTokens,
    cacheReadInputTokens: promptCache.cacheReadInputTokens,
    comparedToPreviousRun: promptCache.comparedToPreviousRun,
    comparisonBasis: promptCache.comparisonBasis,
  });

  return {
    text,
    assistantMessageId,
    timings: {
      firstTokenMs,
      streamTotalMs: roundMs(nowMs() - input.requestStartedAt),
      inputTokens: typeof totalUsage?.inputTokens === "number" ? totalUsage.inputTokens : null,
      outputTokens: typeof totalUsage?.outputTokens === "number" ? totalUsage.outputTokens : null,
      totalTokens: typeof totalUsage?.totalTokens === "number" ? totalUsage.totalTokens : null,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
    diagnostics: {
      resolvedToolCallCount,
      providerMetadataPreview: input.summarizeUnknown(metadata),
      promptCache,
    },
  };
}
