import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { stepCountIs, streamText } from "ai";
import { type AgentContext, loadContext } from "../context/index";
import { reflectOnTurn } from "../context/memory/memoryDistiller";
import { refreshSummaryMemory } from "../context/memory/summaryMemory";
import { getLatestUserMessage } from "../context/session/sessionContext";
import { getBrowserToolRuntime } from "../context/tools/browserTool";
import { hasHealthyDesktopRelay } from "../context/tools/desktopRelayResearch";
import { createProviderModel } from "../providers/providerModelFactory";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  type StoredProviderConfig,
  getActiveProviderConfig,
} from "../repositories/providerRepository";
import {
  appendSessionEvent,
  createAttachment,
  createSessionMessage,
  updateSessionMessage,
  upsertSessionJob,
} from "../repositories/sessionRepository";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";
import { syncSessionProjectHistory } from "../services/sessionProjectService";
import { enqueueSessionRun } from "../services/sessionRunQueue";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
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

  void syncSessionProjectHistory(sessionId).catch(() => {});
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

  void syncSessionProjectHistory(sessionId).catch(() => {});
}

function resolveImageMimeType(filePath: string): string | null {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  return null;
}

function extractToolImagePath(output: unknown): string | null {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as { path?: unknown };
      return typeof parsed.path === "string" ? parsed.path : null;
    } catch {
      return null;
    }
  }

  if (output && typeof output === "object" && "path" in output) {
    const candidate = (output as { path?: unknown }).path;
    return typeof candidate === "string" ? candidate : null;
  }

  return null;
}

function extractJsonObject<T>(value: unknown): T | null {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  if (value && typeof value === "object") {
    return value as T;
  }

  return null;
}

function isBrowserToolName(toolName: string) {
  return toolName.startsWith("browser_");
}

function isResearchToolName(toolName: string) {
  return toolName === "web_fetch" || toolName === "web_search";
}

function extractBrowserToolPayload(value: unknown): { backend?: string; tabId?: string } {
  if (typeof value === "string") {
    const backendMatch = value.match(/Fetch Backend:\s*([A-Za-z0-9_-]+)/);
    const parsed = extractJsonObject<{ backend?: unknown; tabId?: unknown }>(value);
    return {
      backend: typeof parsed?.backend === "string" ? parsed.backend : backendMatch?.[1],
      tabId: typeof parsed?.tabId === "string" ? parsed.tabId : undefined,
    };
  }

  const payload = extractJsonObject<{ backend?: unknown; tabId?: unknown }>(value);
  return {
    backend: typeof payload?.backend === "string" ? payload.backend : undefined,
    tabId: typeof payload?.tabId === "string" ? payload.tabId : undefined,
  };
}

function predictToolBackend(sessionId: string, toolName: string): { backend?: string | null; tabId?: string | null } {
  if (isBrowserToolName(toolName)) {
    return getBrowserToolRuntime(sessionId);
  }

  if (isResearchToolName(toolName)) {
    return {
      backend: hasHealthyDesktopRelay() ? "desktop_chrome" : "http_fetch",
      tabId: null,
    };
  }

  return {
    backend: null,
    tabId: null,
  };
}

function extractBashImagePaths(input: unknown): string[] {
  const toolInput = extractJsonObject<{ command?: unknown; args?: unknown }>(input);
  const command = typeof toolInput?.command === "string" ? toolInput.command : null;
  const args = Array.isArray(toolInput?.args) ? toolInput.args.filter((arg): arg is string => typeof arg === "string") : [];

  if (!command) {
    return [];
  }

  if (command === "/usr/sbin/screencapture" || command === "screencapture") {
    const candidate = [...args].reverse().find((arg) => Boolean(resolveImageMimeType(arg)));
    return candidate ? [candidate] : [];
  }

  if (command === "/usr/bin/sips" || command === "sips") {
    const outIndex = args.findIndex((arg) => arg === "--out");
    if (outIndex >= 0 && outIndex + 1 < args.length && resolveImageMimeType(args[outIndex + 1])) {
      return [args[outIndex + 1]];
    }
  }

  return [];
}

function getToolImagePaths(toolName: string, output: unknown, input?: unknown): string[] {
  if (toolName === "browser_screenshot") {
    const path = extractToolImagePath(output);
    return path ? [path] : [];
  }

  if (toolName === "bash") {
    return extractBashImagePaths(input);
  }

  return [];
}

function looksLikeQrOrLoginContext(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return [
    "qr",
    "qrcode",
    "login",
    "signin",
    "sign-in",
    "auth",
    "passport",
    "verify",
    "scan",
    "wechat",
    "二维码",
    "登录",
    "扫码",
    "验证",
  ].some((keyword) => normalized.includes(keyword));
}

function buildToolImageMessageContent(toolName: string, output: unknown, input: unknown, imagePath: string): string {
  if (toolName === "browser_screenshot") {
    const outputPayload = extractJsonObject<{ url?: unknown }>(output);
    const url = typeof outputPayload?.url === "string" ? outputPayload.url : null;
    if (looksLikeQrOrLoginContext(url) || looksLikeQrOrLoginContext(imagePath)) {
      return "已附上当前登录页截图；如果这里出现二维码，你可以直接扫码。";
    }

    return "已附上当前页面截图，请确认页面状态。";
  }

  if (toolName === "bash") {
    const toolInput = extractJsonObject<{ command?: unknown; args?: unknown }>(input);
    const joinedArgs = Array.isArray(toolInput?.args)
      ? toolInput.args.filter((arg): arg is string => typeof arg === "string").join(" ")
      : "";

    if (looksLikeQrOrLoginContext(joinedArgs) || looksLikeQrOrLoginContext(imagePath)) {
      return "已附上屏幕截图；如果这里有登录二维码，你可以直接扫码。";
    }

    return "已附上屏幕截图，请查看当前界面。";
  }

  return "已附上截图，请查看当前画面。";
}

async function maybePublishToolImageAttachment(
  sessionId: string,
  toolName: string,
  output: unknown,
  input?: unknown,
) {
  const imagePaths = [...new Set(getToolImagePaths(toolName, output, input))];
  if (imagePaths.length === 0) {
    return;
  }

  let published = false;

  for (const imagePath of imagePaths) {
    const mimeType = resolveImageMimeType(imagePath);
    if (!mimeType) {
      continue;
    }

    let stats;
    try {
      stats = statSync(imagePath);
    } catch {
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    const attachmentResult = createAttachment({
      sessionId,
      fileName: basename(imagePath),
      mimeType,
      byteSize: stats.size,
      storagePath: imagePath,
      originalPath: imagePath,
    });

    for (const event of attachmentResult.events) {
      publishSessionEvent(event);
    }

    const messageResult = createSessionMessage({
      sessionId,
      clientMessageId: `tool-image-${randomUUID()}`,
      deviceId: "runtime-agent",
      role: "assistant",
      content: buildToolImageMessageContent(toolName, output, input, imagePath),
      attachmentIds: [attachmentResult.attachment.id],
    });

    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }

    published = true;
  }

  if (published) {
    await syncSessionProjectHistory(sessionId);
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

interface AgentRun {
  sessionId: string;
  jobId: string;
  provider: StoredProviderConfig;
  abortController: AbortController;
  context: AgentContext;
  safety: ReturnType<typeof createSafetyChecker>;
  queueWaitMs: number;
  contextLoadMs: number;
  startedAtMs: number;

  reportStarted(): void;
  reportCompleted(text: string, streamTimings: Record<string, number | null>): void;
  reportFailed(error: unknown): void;
  dispose(): void;
}

async function createAgentRun(sessionId: string, queueWaitMs: number): Promise<AgentRun | null> {
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

  let context: AgentContext;
  const contextStartedAt = nowMs();
  try {
    context = await loadContext(sessionId, abortController.signal);
  } catch (error) {
    activeAgents.delete(sessionId);
    throw error;
  }
  const contextLoadMs = roundMs(nowMs() - contextStartedAt);

  const safety = createSafetyChecker(context.safetyConfig);
  const startedAtMs = nowMs();

  return {
    sessionId,
    jobId,
    provider: activeProvider,
    abortController,
    context,
    safety,
    queueWaitMs,
    contextLoadMs,
    startedAtMs,

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

    reportCompleted(text: string, streamTimings: Record<string, number | null>) {
      const providerRunMs = roundMs(nowMs() - startedAtMs);
      const endToEndMs = roundMs(queueWaitMs + contextLoadMs + providerRunMs);
      publishJob({
        id: jobId,
        sessionId,
        kind: "provider-completion",
        status: "done",
        title: `${activeProvider.label} completed`,
        detail: `Response generated with ${activeProvider.model} (${safety.iterationCount} steps, ${Math.round(safety.elapsedMs / 1000)}s).`,
      });

      logPerfTrace("agent_run", {
        sessionId,
        providerId: activeProvider.id,
        model: activeProvider.model,
        queueWaitMs,
        contextLoadMs,
        context: context.timings,
        stream: streamTimings,
        providerRunMs,
        endToEndMs,
        responseChars: text.length,
        iterations: safety.iterationCount,
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
  timings: Record<string, number | null>;
}

async function executeStream(run: AgentRun): Promise<StreamResult> {
  const requestStartedAt = nowMs();
  const toolCallInputs = new Map<string, unknown>();

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
      toolCallInputs.set(toolCall.toolCallId, toolCall.input);
      const predictedRuntime = predictToolBackend(run.sessionId, toolCall.toolName);
      publishRuntimeEvent(run.sessionId, "tool.call.started", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        inputPreview: summarizeUnknown(toolCall.input),
        backend: predictedRuntime.backend,
        tabId: predictedRuntime.tabId,
      });
    },
    experimental_onToolCallFinish(event) {
      run.safety.checkActive();
      const resultPreview = event.success ? summarizeUnknown(event.output) : summarizeUnknown(event.error);
      const browserPayload = extractBrowserToolPayload(event.success ? event.output : event.error);
      const completedBackend = browserPayload.backend
        ?? predictToolBackend(run.sessionId, event.toolCall.toolName).backend
        ?? null;
      const completedTabId = browserPayload.tabId ?? null;

      publishRuntimeEvent(run.sessionId, "tool.call.completed", {
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success,
        resultPreview,
        durationMs: event.durationMs,
        backend: completedBackend,
        tabId: completedTabId,
      });
      logPerfTrace("tool_call", {
        sessionId: run.sessionId,
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success ? 1 : 0,
        durationMs: typeof event.durationMs === "number" ? roundMs(event.durationMs) : null,
        browserBackend: completedBackend,
        tabId: completedTabId,
      });
      if (event.success) {
        void maybePublishToolImageAttachment(
          run.sessionId,
          event.toolCall.toolName,
          event.output,
          toolCallInputs.get(event.toolCall.toolCallId),
        ).catch(() => {});
      }
      toolCallInputs.delete(event.toolCall.toolCallId);
    },
  });
  const streamSetupMs = roundMs(nowMs() - requestStartedAt);

  const { text, timings } = await consumeTextStream(run, stream, requestStartedAt);
  return {
    text,
    timings: {
      streamSetupMs,
      ...timings,
    },
  };
}

// ---------------------------------------------------------------------------
// consumeTextStream — stream delta → DB with debounce
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 80;

async function consumeTextStream(
  run: AgentRun,
  stream: Awaited<ReturnType<typeof streamText>>,
  requestStartedAt: number,
): Promise<{ text: string; timings: Record<string, number | null> }> {
  let text = "";
  const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
  let assistantMessageId: string | null = null;
  let pendingFlush = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTokenMs: number | null = null;

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
      firstTokenMs = roundMs(nowMs() - requestStartedAt);
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

  await syncSessionProjectHistory(run.sessionId);

  // Log cache statistics if available
  const metadata = await stream.providerMetadata;
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

  return {
    text,
    timings: {
      firstTokenMs,
      streamTotalMs: roundMs(nowMs() - requestStartedAt),
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// schedulePostProcessing — fire-and-forget, never blocks the main turn
// ---------------------------------------------------------------------------

function schedulePostProcessing(run: AgentRun, text: string) {
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
    userMessages,
    assistantResponse: text,
  })
    .catch(() => {
      // Reflection failure should not fail the user-visible turn.
    });

  if (!latestUserMessage) {
    return;
  }

  void (async () => {
    const prefetchedRecallStartedAt = nowMs();
    let prefetchedRecall = null;

    try {
      prefetchedRecall = await (run.context.asyncSemanticSearch?.result ?? Promise.resolve(null));
    } catch {
      prefetchedRecall = null;
    }

    await refreshSummaryMemory(run.sessionId, latestUserMessage, text, {
      prefetchedRecall,
      prefetchedRecallWaitMs: roundMs(nowMs() - prefetchedRecallStartedAt),
      allowSemanticFallback: run.context.memoryRoute.useAtomicMemory,
    });
  })().catch(() => {
    // Summary refresh failure should not fail the user-visible turn.
  });
}

// ---------------------------------------------------------------------------
// Public API (unchanged exports)
// ---------------------------------------------------------------------------

export async function runAgent(sessionId: string) {
  const enqueuedAt = nowMs();
  return enqueueSessionRun(sessionId, async () => {
    const queueWaitMs = roundMs(nowMs() - enqueuedAt);
    const run = await createAgentRun(sessionId, queueWaitMs);
    if (!run) return;

    try {
      run.reportStarted();
      const { text, timings } = await executeStream(run);
      run.reportCompleted(text, timings);
      schedulePostProcessing(run, text);
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
