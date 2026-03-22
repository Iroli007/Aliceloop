import { randomUUID } from "node:crypto";
import { stepCountIs, streamText } from "ai";
import { type AgentContext, loadContext } from "../context/index";
import { reflectOnTurn } from "../context/memory/memoryDistiller";
import { getLatestUserMessage } from "../context/session/sessionContext";
import { createProviderModel } from "../providers/providerModelFactory";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  type StoredProviderConfig,
  getActiveProviderConfig,
} from "../repositories/providerRepository";
import {
  appendSessionEvent,
  createSessionMessage,
  updateSessionMessage,
  upsertSessionJob,
} from "../repositories/sessionRepository";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";
import { enqueueSessionRun } from "../services/sessionRunQueue";
import { createSafetyChecker, SafetyLimitError } from "./safetyGuard";

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------

function publishJob(input: Parameters<typeof upsertSessionJob>[0]) {
  const result = upsertSessionJob(input);
  publishSessionEvent(result.event);
  return result.job;
}

function publishRuntimeNotice(sessionId: string, content: string) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `runtime-notice-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "system",
    content,
    attachmentIds: [],
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }
}

function publishAssistantReply(sessionId: string, content: string) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `assistant-reply-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "assistant",
    content,
    attachmentIds: [],
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }
}

function buildLocalFallbackReply(userMessage: string | null) {
  const normalized = userMessage?.trim();

  if (!normalized) {
    return "已收到你的消息。当前还没有配置可用的模型网关，所以这里先返回本地组装的 assistant 回复，确认 Aliceloop 的最小闭环已经打通。";
  }

  return [
    "已收到你的消息，Aliceloop 的最小闭环是通的。",
    `我收到的是：${normalized}`,
    "当前还没有配置可用的模型网关，所以这里先返回本地组装的 assistant 回复。配置 API key 后，这里会切换成真实模型生成。",
  ].join("\n\n");
}

function summarizeUnknown(value: unknown, maxLength = 800) {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return null;
    }

    return serialized.length > maxLength ? `${serialized.slice(0, maxLength).trimEnd()}…` : serialized;
  } catch {
    return String(value);
  }
}

function publishRuntimeEvent(
  sessionId: string,
  type: "tool.call.started" | "tool.call.completed",
  payload: Record<string, unknown>,
) {
  const event = appendSessionEvent(sessionId, type, payload);
  publishSessionEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// AgentRun — lightweight value object for a single run
// ---------------------------------------------------------------------------

interface ToolCallEntry {
  name: string;
  args: unknown;
  result: unknown;
}

interface AgentRun {
  sessionId: string;
  jobId: string;
  provider: StoredProviderConfig;
  abortController: AbortController;
  context: AgentContext;
  safety: ReturnType<typeof createSafetyChecker>;

  reportStarted(): void;
  reportCompleted(text: string): void;
  reportFailed(error: unknown): void;
  dispose(): void;
}

function createAgentRun(sessionId: string): AgentRun | null {
  const activeProvider = getActiveProviderConfig();
  const jobId = randomUUID();

  if (!activeProvider || !activeProvider.apiKey) {
    publishAssistantReply(sessionId, buildLocalFallbackReply(getLatestUserMessage(sessionId)));
    publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "done",
      title: "Local fallback reply",
      detail: "No enabled model gateway with an API key is configured, so Aliceloop returned a local assembled assistant reply.",
    });
    return null;
  }

  const abortController = new AbortController();
  activeAgents.set(sessionId, abortController);

  const context = loadContext(sessionId, abortController.signal);
  const safety = createSafetyChecker(context.safetyConfig);

  return {
    sessionId,
    jobId,
    provider: activeProvider,
    abortController,
    context,
    safety,

    reportStarted() {
      publishJob({
        id: jobId,
        sessionId,
        kind: "provider-completion",
        status: "running",
        title: `${activeProvider.label} is responding`,
        detail: `Using ${activeProvider.model} for this response.`,
      });
    },

    reportCompleted(text: string) {
      publishJob({
        id: jobId,
        sessionId,
        kind: "provider-completion",
        status: "done",
        title: `${activeProvider.label} completed`,
        detail: `Response generated with ${activeProvider.model} (${safety.iterationCount} steps, ${Math.round(safety.elapsedMs / 1000)}s).`,
      });
    },

    reportFailed(error: unknown) {
      if (error instanceof SafetyLimitError) {
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: "Agent stopped",
          detail: error.message,
        });
        publishRuntimeNotice(sessionId, error.message);
      } else if (abortController.signal.aborted) {
        const detail = "Agent loop aborted: user sent a new message or requested cancellation.";
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: "Agent stopped",
          detail,
        });
        publishRuntimeNotice(sessionId, detail);
      } else {
        const detail = error instanceof Error ? error.message : "Agent call failed";
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: `${activeProvider.label} failed`,
          detail,
        });
        publishRuntimeNotice(sessionId, `Agent error: ${detail}`);
      }
    },

    dispose() {
      activeAgents.delete(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// executeStream — AI call + message streaming loop
// ---------------------------------------------------------------------------

interface StreamResult {
  text: string;
  toolCalls: ToolCallEntry[];
}

async function executeStream(run: AgentRun): Promise<StreamResult> {
  const toolCalls: ToolCallEntry[] = [];

  const stream = streamText({
    model: createProviderModel(run.provider),
    system: run.context.systemPrompt,
    messages: run.context.messages,
    tools: run.context.tools,
    stopWhen: stepCountIs(run.context.safetyConfig.maxIterations),
    abortSignal: run.abortController.signal,
    experimental_onStepStart() {
      run.safety.checkStep();
    },
    experimental_onToolCallStart({ toolCall }) {
      run.safety.checkActive();
      publishRuntimeEvent(run.sessionId, "tool.call.started", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        inputPreview: summarizeUnknown(toolCall.input),
      });
    },
    experimental_onToolCallFinish(event) {
      run.safety.checkActive();
      const resultPreview = event.success ? summarizeUnknown(event.output) : summarizeUnknown(event.error);

      publishRuntimeEvent(run.sessionId, "tool.call.completed", {
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success,
        resultPreview,
        durationMs: event.durationMs,
      });

      toolCalls.push({
        name: event.toolCall.toolName,
        args: event.toolCall.input,
        result: event.success ? event.output : resultPreview,
      });
    },
  });

  const text = await consumeTextStream(run, stream);
  return { text, toolCalls };
}

// ---------------------------------------------------------------------------
// consumeTextStream — stream delta → DB with debounce
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 80;

async function consumeTextStream(
  run: AgentRun,
  stream: Awaited<ReturnType<typeof streamText>>,
): Promise<string> {
  let text = "";
  const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
  let assistantMessageId: string | null = null;
  let pendingFlush = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (!assistantMessageId || !pendingFlush) return;
    pendingFlush = false;
    const updateResult = updateSessionMessage({
      sessionId: run.sessionId,
      messageId: assistantMessageId,
      content: text,
    });
    publishSessionEvent(updateResult.event);
  }

  for await (const delta of stream.textStream) {
    run.safety.checkActive();
    if (!delta) continue;

    text += delta;

    if (!assistantMessageId) {
      // First delta: create the message immediately
      const messageResult = createSessionMessage({
        sessionId: run.sessionId,
        clientMessageId: assistantClientMessageId,
        deviceId: "runtime-agent",
        role: "assistant",
        content: text,
        attachmentIds: [],
      });

      assistantMessageId = messageResult.message.id;
      for (const event of messageResult.events) {
        publishSessionEvent(event);
      }
      continue;
    }

    // Subsequent deltas: debounce updates
    pendingFlush = true;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flush();
        flushTimer = null;
      }, DEBOUNCE_MS);
    }
  }

  // Flush any remaining content after the stream ends
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingFlush) flush();

  // Handle tool-only replies with no text
  if (!text.trim()) {
    const resolvedToolCalls = await stream.toolCalls;
    if (resolvedToolCalls.length > 0) {
      text = `已完成 ${resolvedToolCalls.length} 次工具调用。`;
    }
  }

  // Handle late message creation (text appeared after stream end, or tool-only fallback)
  if (!assistantMessageId && text) {
    const messageResult = createSessionMessage({
      sessionId: run.sessionId,
      clientMessageId: assistantClientMessageId,
      deviceId: "runtime-agent",
      role: "assistant",
      content: text,
      attachmentIds: [],
    });
    assistantMessageId = messageResult.message.id;
    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }
  }

  // Log cache statistics if available
  const metadata = await stream.experimental_providerMetadata;
  if (metadata?.anthropic) {
    const { cacheCreationInputTokens, cacheReadInputTokens } = metadata.anthropic;
    if (cacheCreationInputTokens || cacheReadInputTokens) {
      console.log(`[Cache] write=${cacheCreationInputTokens ?? 0} read=${cacheReadInputTokens ?? 0}`);
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// schedulePostProcessing — fire-and-forget, never blocks the main turn
// ---------------------------------------------------------------------------

function schedulePostProcessing(run: AgentRun, text: string, toolCalls: ToolCallEntry[]) {
  const userMessages = run.context.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
  const latestUserMessage = userMessages.at(-1) ?? null;

  if (latestUserMessage) {
    void maybeCreateArtifactFromReply(run.sessionId, latestUserMessage, text).catch((err) => {
      const detail = err instanceof Error ? err.message : "工件写入失败";
      publishRuntimeNotice(run.sessionId, `工件流式写入失败：${detail}`);
    });
  }

  void reflectOnTurn({
    sessionId: run.sessionId,
    userMessages,
    assistantResponse: text,
    toolCalls,
  }).catch(() => {
    // Reflection failure should not fail the user-visible turn.
  });
}

// ---------------------------------------------------------------------------
// Public API (unchanged exports)
// ---------------------------------------------------------------------------

export async function runAgent(sessionId: string) {
  return enqueueSessionRun(sessionId, async () => {
    const run = createAgentRun(sessionId);
    if (!run) return;

    try {
      run.reportStarted();
      const { text, toolCalls } = await executeStream(run);
      run.reportCompleted(text);
      schedulePostProcessing(run, text, toolCalls);
    } catch (error) {
      run.reportFailed(error);
    } finally {
      run.dispose();
    }
  });
}

const activeAgents = new Map<string, AbortController>();

export function abortAgentForSession(sessionId: string) {
  const controller = activeAgents.get(sessionId);
  if (!controller) {
    return false;
  }

  controller.abort();
  return true;
}
