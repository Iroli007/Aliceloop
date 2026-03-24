import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import { stepCountIs, streamText } from "ai";
import { type AgentContext, loadContext } from "../context/index";
import { autoCompactMessages } from "./autoCompact";
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
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
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
import { requestSessionToolApproval } from "../services/sessionToolApprovalService";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
import { createSafetyChecker, SafetyLimitError } from "./safetyGuard";
import { saveStreamCheckpoint, clearStreamCheckpoint } from "./streamCheckpoint";
import { ToolStateMachine, type ToolCallState } from "./toolStateMachine";

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
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return null;
}

function extractImagePathsFromText(value: string): string[] {
  const matches = value.match(/\/[^\s"'`<>]+?\.(?:png|jpe?g|webp|gif|svg)\b/giu) ?? [];
  return matches.filter((candidate, index, items) => items.indexOf(candidate) === index);
}

function extractImagePathsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return extractImagePathsFromText(value);
  }
  // 只处理字符串，其他类型忽略
  return [];
}

function extractToolImagePath(output: unknown): string | null {
  // 只处理 object 类型，string 类型不处理
  if (output && typeof output === "object" && "path" in output) {
    const candidate = (output as { path?: unknown }).path;
    return typeof candidate === "string" ? candidate : null;
  }
  return null;
}

function extractJsonObject<T>(value: unknown): T | null {
  // 只处理已经是 object 的情况
  if (value && typeof value === "object") {
    return value as T;
  }
  return null;
}

function isBrowserToolName(toolName: string) {
  return toolName.startsWith("browser_");
}

function looksLikeBinaryTextDump(value: string) {
  if (/data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    return true;
  }

  return /[A-Za-z0-9+/=]{1800,}/u.test(value.replace(/\s+/g, ""));
}

function sanitizeAssistantTextForChat(value: string) {
  const strippedAttachmentMarkers = value
    .replace(/^\[(Attached files?|Attached directory tree|Attached file content):[^\n]*\]\s*$/gimu, "")
    .trim();
  const normalized = strippedAttachmentMarkers || value;

  if (!looksLikeBinaryTextDump(normalized)) {
    return normalized;
  }

  return [
    "我没有返回可直接显示的真实图片附件。",
    "如果需要二维码、登录页或截图，我应该打开真实页面并用 `browser_screenshot` 或受支持的截图链路把图片作为附件发回聊天，而不是粘贴 base64 / SVG 文本。",
  ].join("\n");
}

function isResearchToolName(toolName: string) {
  return toolName === "web_fetch" || toolName === "web_search";
}

function normalizeReasoningModelId(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function resolveProviderTransport(config: StoredProviderConfig) {
  if (config.transport !== "auto") {
    return config.transport;
  }

  if (normalizeReasoningModelId(config.model).startsWith("claude")) {
    return "anthropic" as const;
  }

  return "openai-compatible" as const;
}

function supportsReasoningEffort(config: StoredProviderConfig) {
  if (resolveProviderTransport(config) !== "openai-compatible") {
    return false;
  }

  const modelId = normalizeReasoningModelId(config.model);
  return modelId.startsWith("o1")
    || modelId.startsWith("o3")
    || modelId.startsWith("o4-mini")
    || (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat"));
}

function mapReasoningEffortToOpenAI(effort: ReasoningEffort) {
  return effort === "off" ? "none" : effort;
}

function buildAgentProviderOptions(config: StoredProviderConfig, reasoningEffort: ReasoningEffort) {
  if (!supportsReasoningEffort(config)) {
    return undefined;
  }

  return {
    openai: {
      reasoningEffort: mapReasoningEffortToOpenAI(reasoningEffort),
      forceReasoning: true,
    },
  };
}

function extractBrowserToolPayload(value: unknown): { backend?: string; tabId?: string } {
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

function extractBashImagePaths(input: unknown, output?: unknown): string[] {
  const toolInput = extractJsonObject<{ command?: string; args?: string[] }>(input);
  if (!toolInput) return [];

  const { command, args = [] } = toolInput;
  const discovered = new Set<string>();

  if (command === "/usr/sbin/screencapture" || command === "screencapture") {
    const candidate = [...args].reverse().find((arg) => Boolean(resolveImageMimeType(arg)));
    if (candidate) discovered.add(candidate);
  }

  if (command === "/usr/bin/sips" || command === "sips") {
    const outIndex = args.findIndex((arg) => arg === "--out");
    if (outIndex >= 0 && outIndex + 1 < args.length && resolveImageMimeType(args[outIndex + 1])) {
      discovered.add(args[outIndex + 1]);
    }
  }

  for (const imagePath of extractImagePathsFromText(args.join(" "))) {
    discovered.add(imagePath);
  }

  for (const imagePath of extractImagePathsFromUnknown(output)) {
    discovered.add(imagePath);
  }

  return [...discovered];
}

function getToolImagePaths(toolName: string, output: unknown, input?: unknown): string[] {
  if (toolName === "browser_screenshot") {
    const path = extractToolImagePath(output);
    return path ? [path] : [];
  }

  if (toolName === "bash") {
    return extractBashImagePaths(input, output);
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

type RuntimeEventType =
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.approval.requested"
  | "tool.approval.resolved"
  | "tool.state.change";

function publishRuntimeEvent(
  sessionId: string,
  type: RuntimeEventType,
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
  const runtimeSettings = getRuntimeSettings();

  // Tool state machine for tracking tool call lifecycle
  const stateMachine = new ToolStateMachine();

  // Publish state changes as session events
  stateMachine.onStateChange((state) => {
    publishRuntimeEvent(run.sessionId, "tool.state.change", {
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      status: state.status,
      input: state.input,
      output: state.output,
      error: state.error,
    });
  });

  const stream = streamText({
    model: createProviderModel(run.provider),
    system: run.context.systemPrompt,
    messages: autoCompactMessages(run.context.messages, 4),
    tools: run.context.tools,
    providerOptions: buildAgentProviderOptions(run.provider, runtimeSettings.reasoningEffort),
    stopWhen: stepCountIs(run.context.safetyConfig.maxIterations),
    abortSignal: run.abortController.signal,
    prepareStep({ steps }) {
      if (steps.length !== 0 || !run.context.firstStepToolChoice) {
        return undefined;
      }

      return {
        toolChoice: run.context.firstStepToolChoice,
      };
    },
    experimental_onStepStart() {
      run.safety.checkStep();
    },
    experimental_onToolCallStart({ toolCall }) {
      run.safety.checkActive();
      toolCallInputs.set(toolCall.toolCallId, toolCall.input);

      // Start tracking tool call state
      stateMachine.start(toolCall.toolCallId, toolCall.toolName, toolCall.input);
      stateMachine.markInputAvailable(toolCall.toolCallId);

      // Check if this tool needs approval
      if (!runtimeSettings.autoApproveToolRequests && stateMachine.needsApproval(toolCall.toolName)) {
        // Publish approval request event
        publishRuntimeEvent(run.sessionId, "tool.approval.requested", {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          inputPreview: summarizeUnknown(toolCall.input),
        });
      }

      const predictedRuntime = predictToolBackend(run.sessionId, toolCall.toolName);
      publishRuntimeEvent(run.sessionId, "tool.call.started", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        inputPreview: summarizeUnknown(toolCall.input),
        backend: predictedRuntime.backend,
        tabId: predictedRuntime.tabId,
        state: "input-available",
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

      // Update tool state machine
      if (event.success) {
        stateMachine.markOutputAvailable(event.toolCall.toolCallId, event.output);
      } else {
        stateMachine.markError(event.toolCall.toolCallId, event.error);
      }
      stateMachine.complete(event.toolCall.toolCallId);

      publishRuntimeEvent(run.sessionId, "tool.call.completed", {
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
        success: event.success,
        resultPreview,
        durationMs: event.durationMs,
        backend: completedBackend,
        tabId: completedTabId,
        state: event.success ? "output-available" : "output-error",
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
      content: sanitizeAssistantTextForChat(text),
    });
    publishSessionEvent(updateResult.event);
  }

  for await (const delta of stream.textStream) {
    run.safety.checkActive();
    if (!delta) continue;

    text += delta;

    // 保存checkpoint，防止中断丢失进度
    saveStreamCheckpoint(run.sessionId, text);

    if (!assistantMessageId) {
      firstTokenMs = roundMs(nowMs() - requestStartedAt);
      // First delta: create the message immediately
      const messageResult = createSessionMessage({
        sessionId: run.sessionId,
        clientMessageId: assistantClientMessageId,
        deviceId: "runtime-agent",
        role: "assistant",
        content: sanitizeAssistantTextForChat(text),
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
      content: sanitizeAssistantTextForChat(text),
      attachmentIds: [],
    });
    assistantMessageId = messageResult.message.id;
    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }
  }

  await syncSessionProjectHistory(run.sessionId);

  // 清理checkpoint
  clearStreamCheckpoint(run.sessionId);

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
