import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { stepCountIs, streamText } from "ai";
import { type AgentContext, loadContext } from "../context/index";
import { getLatestUserMessage } from "../context/session/sessionContext";
import { getBrowserToolRuntime } from "../context/tools/browserTool";
import { hasHealthyDesktopRelay } from "../context/tools/desktopRelayResearch";
import { createProviderModel } from "../providers/providerModelFactory";
import { getToolModelConfig } from "../providers/toolModelResolver";
import { publishSessionEvent } from "../realtime/sessionStreams";
import { type StoredProviderConfig } from "../repositories/providerRepository";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import {
  appendSessionEvent,
  createAttachment,
  createSessionMessage,
  upsertSessionJob,
} from "../repositories/sessionRepository";
import { syncSessionProjectHistory } from "../services/sessionProjectService";
import { enqueueSessionRun } from "../services/sessionRunQueue";
import { requestSessionToolApproval } from "../services/sessionToolApprovalService";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
import { createSafetyChecker, SafetyLimitError } from "./safetyGuard";
import { ToolStateMachine } from "./toolStateMachine";
import {
  buildAgentProviderOptions,
  resolveProviderTransport,
} from "./providerRuntimeAdapter";
import { executeMiniMaxTextToolCallFallback } from "./minimaxTextToolFallback";
import { consumeTextStream } from "./streamPersistence";
import { createToolOrchestration } from "./toolOrchestration";
import {
  buildCapabilityFailureReply,
  inferCapabilityRecoveryRequest,
  looksLikeCapabilitySeekingReply,
  MAX_CAPABILITY_RECOVERY_ATTEMPTS,
} from "./capabilityRecovery";
import type { PromptCacheRunTrace } from "./promptCacheTelemetry";
import { schedulePostProcessing } from "./postProcessing";

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

function publishAssistantReply(sessionId: string, content: string, eventPayload?: Record<string, unknown>) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `assistant-reply-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "assistant",
    content,
    attachmentIds: [],
    eventPayload,
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
  const payload = extractJsonObject<{ path?: unknown }>(output);
  return typeof payload?.path === "string" ? payload.path : null;
}

function extractJsonObject<T>(value: unknown): T | null {
  if (value && typeof value === "object") {
    return value as T;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as T) : null;
    } catch {
      return null;
    }
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

  if (toolName === "web_search") {
    return {
      backend: hasHealthyDesktopRelay() ? "desktop_chrome" : "http_search",
      tabId: null,
    };
  }

  if (toolName === "web_fetch") {
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
  const toolInput = extractJsonObject<{ command?: string; args?: string[]; script?: string }>(input);
  if (!toolInput) return [];

  const { command, args = [], script } = toolInput;
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

  if (typeof script === "string") {
    for (const imagePath of extractImagePathsFromText(script)) {
      discovered.add(imagePath);
    }
  }

  for (const imagePath of extractImagePathsFromUnknown(output)) {
    discovered.add(imagePath);
  }

  return [...discovered];
}

function getToolImagePaths(toolName: string, output: unknown, input?: unknown): string[] {
  if (toolName === "browser_screenshot" || toolName === "chrome_relay_screenshot") {
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
  if (toolName === "browser_screenshot" || toolName === "chrome_relay_screenshot") {
    const outputPayload = extractJsonObject<{ url?: unknown }>(output);
    const url = typeof outputPayload?.url === "string" ? outputPayload.url : null;
    if (looksLikeQrOrLoginContext(url) || looksLikeQrOrLoginContext(imagePath)) {
      return "已附上当前登录页截图；如果这里出现二维码，你可以直接扫码。";
    }

    return "已附上当前页面截图。请先根据截图确认底部输入框、发送按钮或展开入口是否已经可见；如果目标控件在截图里但不在旧 DOM 快照里，不要继续搜旧 ref，先滚动并重新截图/快照，或调用 view_image 做更具体的视觉分析。";
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
  enableAnthropicToolSearch: boolean;
  abortController: AbortController;
  context: AgentContext;
  safety: ReturnType<typeof createSafetyChecker>;
  queueWaitMs: number;
  contextLoadMs: number;
  startedAtMs: number;

  reportStarted(): void;
  reportCompleted(text: string, streamTimings: Record<string, number | string | null>): void;
  reportFailed(error: unknown): void;
  dispose(): void;
}

interface RunAgentOptions {
  model?: string;
}

function applyRunOptions(provider: StoredProviderConfig, options?: RunAgentOptions): StoredProviderConfig {
  const model = options?.model?.trim();
  if (!model) {
    return provider;
  }

  return {
    ...provider,
    model,
  };
}

async function createAgentRun(
  sessionId: string,
  queueWaitMs: number,
  jobId: string,
  options?: RunAgentOptions,
): Promise<AgentRun | null> {
  const baseProvider = getToolModelConfig();
  const activeProvider = baseProvider ? applyRunOptions(baseProvider, options) : null;

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
  const enableAnthropicToolSearch = activeProvider.id === "anthropic"
    && resolveProviderTransport(activeProvider) === "anthropic"
    && /claude-(?:sonnet|opus|mythos)/iu.test(activeProvider.model);

  let context: AgentContext;
  const contextStartedAt = nowMs();
  try {
    context = await loadContext(sessionId, abortController.signal, {
      enableAnthropicToolSearch,
    });
  } catch (error) {
    activeAgents.delete(sessionId);
    throw error;
  }
  const contextLoadMs = roundMs(nowMs() - contextStartedAt);

  const safety = createSafetyChecker(context.safetyConfig);
  const startedAtMs = nowMs();

  const run: AgentRun = {
    sessionId,
    jobId,
    provider: activeProvider,
    enableAnthropicToolSearch,
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

    reportCompleted(text: string, streamTimings: Record<string, number | string | null>) {
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
        context: run.context.timings,
        stream: streamTimings,
        providerRunMs,
        endToEndMs,
        responseChars: text.length,
        iterations: safety.iterationCount,
        promptCache: {
          cacheCreationInputTokens: typeof streamTimings.cacheCreationInputTokens === "number"
            ? streamTimings.cacheCreationInputTokens
            : null,
          cacheReadInputTokens: typeof streamTimings.cacheReadInputTokens === "number"
            ? streamTimings.cacheReadInputTokens
            : null,
        },
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

  return run;
}

// ---------------------------------------------------------------------------
// executeStream — AI call + message streaming loop
// ---------------------------------------------------------------------------

interface StreamResult {
  text: string;
  timings: Record<string, number | null>;
  diagnostics?: {
    resolvedToolCallCount: number;
    providerMetadataPreview: string | null;
    promptCache: PromptCacheRunTrace | null;
  };
}

async function executeStreamAttempt(
  run: AgentRun,
  existingAssistantMessageId?: string | null,
): Promise<StreamResult & { assistantMessageId: string | null; attachedToolNames: string[] }> {
  const requestStartedAt = nowMs();
  const runtimeSettings = getRuntimeSettings();
  const stateMachine = new ToolStateMachine();
  const toolOrchestration = createToolOrchestration({
    sessionId: run.sessionId,
    stateMachine,
    autoApproveToolRequests: runtimeSettings.autoApproveToolRequests,
    checkActive: () => run.safety.checkActive(),
    summarizeUnknown,
    predictToolBackend,
    extractBrowserToolPayload,
    publishRuntimeEvent,
    maybePublishToolImageAttachment,
  });

  const stream = streamText({
    model: createProviderModel(run.provider, {
      sessionId: run.sessionId,
      enablePromptCacheEditing: true,
    }),
    system: run.context.systemPrompt,
    messages: run.context.messages,
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
    ...toolOrchestration,
  });
  const streamSetupMs = roundMs(nowMs() - requestStartedAt);

  const { text, timings, diagnostics, assistantMessageId } = await consumeTextStream({
    sessionId: run.sessionId,
    providerId: run.provider.id,
    context: run.context,
    stream,
    stateMachine,
    reasoningEffort: runtimeSettings.reasoningEffort,
    requestStartedAt,
    existingAssistantMessageId: existingAssistantMessageId ?? null,
    checkActive: () => run.safety.checkActive(),
    summarizeUnknown,
    resolveTextFallback: ({ assistantText, stateMachine: fallbackStateMachine, reasoningEffort }) => {
      return executeMiniMaxTextToolCallFallback({
        sessionId: run.sessionId,
        provider: run.provider,
        context: run.context,
        abortSignal: run.abortController.signal,
        stateMachine: fallbackStateMachine,
        reasoningEffort,
        assistantText,
        summarizeUnknown,
        predictToolBackend,
        extractBrowserToolPayload,
        publishRuntimeEvent,
        maybePublishToolImageAttachment,
      });
    },
  });
  return {
    text,
    timings: {
      streamSetupMs,
      ...timings,
    },
    diagnostics,
    assistantMessageId,
    attachedToolNames: Object.keys(run.context.tools),
  };
}

async function executeStream(run: AgentRun): Promise<StreamResult> {
  let assistantMessageId: string | null = null;
  let lastResult: StreamResult | null = null;
  let finalResult: StreamResult | null = null;
  const accumulatedStickySkillIds = new Set<string>();
  const accumulatedToolNames = new Set<string>();
  const attemptedRecoveryReasons = new Set<string>();
  const latestUserMessage = getLatestUserMessage(run.sessionId);

  for (let attempt = 0; attempt < MAX_CAPABILITY_RECOVERY_ATTEMPTS; attempt += 1) {
    const result = await executeStreamAttempt(run, assistantMessageId);
    assistantMessageId = result.assistantMessageId;
    lastResult = {
      text: result.text,
      timings: result.timings,
      diagnostics: result.diagnostics,
    };

    const recovery = inferCapabilityRecoveryRequest(
      latestUserMessage,
      result.text,
      result.attachedToolNames,
      result.diagnostics?.resolvedToolCallCount ?? 0,
    );
    const isLastAttempt = attempt >= MAX_CAPABILITY_RECOVERY_ATTEMPTS - 1;
    if (!recovery || attemptedRecoveryReasons.has(recovery.reason) || isLastAttempt) {
      if (
        lastResult
        && (lastResult.diagnostics?.resolvedToolCallCount ?? 0) === 0
        && looksLikeCapabilitySeekingReply(lastResult.text)
      ) {
        lastResult = {
          ...lastResult,
          text: buildCapabilityFailureReply(latestUserMessage, result.attachedToolNames),
        };
      }
      finalResult = lastResult;
      break;
    }

    attemptedRecoveryReasons.add(recovery.reason);
    for (const skillId of recovery.additionalStickySkillIds) {
      accumulatedStickySkillIds.add(skillId);
    }
    for (const toolName of recovery.additionalToolNames) {
      accumulatedToolNames.add(toolName);
    }

    run.context = await loadContext(run.sessionId, run.abortController.signal, {
      additionalStickySkillIds: [...accumulatedStickySkillIds],
      additionalToolNames: [...accumulatedToolNames],
      enableAnthropicToolSearch: run.enableAnthropicToolSearch,
    });
  }

  const fallbackResult = finalResult ?? lastResult ?? {
    text: "",
    timings: {},
    diagnostics: {
      resolvedToolCallCount: 0,
      providerMetadataPreview: null,
      promptCache: null,
    },
  };

  if (
    (fallbackResult.diagnostics?.resolvedToolCallCount ?? 0) === 0
    && looksLikeCapabilitySeekingReply(fallbackResult.text)
  ) {
    return {
      ...fallbackResult,
      text: buildCapabilityFailureReply(latestUserMessage, [...accumulatedToolNames]),
    };
  }

  return fallbackResult;
}

// ---------------------------------------------------------------------------
// Public API (unchanged exports)
// ---------------------------------------------------------------------------

export async function runAgent(sessionId: string, options?: RunAgentOptions) {
  const enqueuedAt = nowMs();
  const queuedJobId = randomUUID();
  publishJob({
    id: queuedJobId,
    sessionId,
    kind: "provider-completion",
    status: "queued",
    title: "Preparing response",
    detail: "Loading context and tools before the model starts responding.",
  });
  return enqueueSessionRun(sessionId, async () => {
    const queueWaitMs = roundMs(nowMs() - enqueuedAt);
    const run = await createAgentRun(sessionId, queueWaitMs, queuedJobId, options);
    if (!run) return;

    try {
      run.reportStarted();
      const { text, timings, diagnostics } = await executeStream(run);
      if (!text.trim()) {
        const diagnosticLines = [
          `provider=${run.provider.label}`,
          `model=${run.provider.model}`,
          `transport=${resolveProviderTransport(run.provider)}`,
          `tools=${Object.keys(run.context.tools).join(",") || "(none)"}`,
          `resolvedToolCalls=${diagnostics?.resolvedToolCallCount ?? 0}`,
          `providerMetadata=${diagnostics?.providerMetadataPreview ?? "(none)"}`,
          `latestUser=${JSON.stringify(getLatestUserMessage(run.sessionId) ?? "")}`,
        ];
        console.error(`[agent-empty-output] session=${run.sessionId} ${diagnosticLines.join(" | ")}`);
      }
      run.reportCompleted(text, {
        ...timings,
        resolvedToolCallCount: diagnostics?.resolvedToolCallCount ?? null,
      });
      schedulePostProcessing({
        sessionId: run.sessionId,
        messages: run.context.messages,
        assistantText: text,
        publishRuntimeNotice,
      });
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
