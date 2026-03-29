import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { statSync } from "node:fs";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import { generateText, stepCountIs, streamText } from "ai";
import { type AgentContext, loadContext } from "../context/index";
import { autoCompactMessages } from "./autoCompact";
import { reflectOnTurn } from "../context/memory/memoryDistiller";
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
  getSessionWorksetState,
  updateSessionMessage,
  updateSessionWorksetState,
  upsertSessionJob,
} from "../repositories/sessionRepository";
import { createMemory } from "../context/memory/memoryRepository";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";
import { syncSessionProjectHistory } from "../services/sessionProjectService";
import { enqueueSessionRun } from "../services/sessionRunQueue";
import { requestSessionToolApproval } from "../services/sessionToolApprovalService";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
import { createSafetyChecker, SafetyLimitError } from "./safetyGuard";
import { saveStreamCheckpoint, clearStreamCheckpoint } from "./streamCheckpoint";
import { ToolStateMachine, type ToolCallState } from "./toolStateMachine";
import { repairTextToolCall } from "./toolCallRepair";
import { inferSkillIdsForToolCall } from "../context/tools/toolSkillRouting";
import {
  cloneWorksetState,
  type SessionWorksetState,
  type WorksetEntryState,
} from "../context/workset/worksetState";

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

function publishAssistantReply(sessionId: string, content: string, skills: string[] = []) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `assistant-reply-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "assistant",
    content,
    attachmentIds: [],
    eventPayload: skills.length > 0 ? { skills } : undefined,
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }

  void syncSessionProjectHistory(sessionId).catch(() => {});
}

function buildAssistantEventPayload(skills: string[], tools: string[]) {
  const payload: { skills?: string[]; tools?: string[] } = {};
  if (skills.length > 0) {
    payload.skills = skills;
  }
  if (tools.length > 0) {
    payload.tools = tools;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function createWorksetEntryState(): WorksetEntryState {
  return {
    score: 0,
    idleTurns: 0,
    active: false,
    lastAttachedTurn: null,
    lastUsedTurn: null,
  };
}

function normalizeAttachedNames(values: Iterable<string>) {
  return [...new Set(
    [...values]
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

function isCountedToolCall(state: ToolCallState) {
  return ![
    "input-streaming",
    "input-available",
    "approval-requested",
    "approval-responded",
  ].includes(state.status);
}

function settleWorksetAfterTurn(input: {
  sessionId: string;
  startingState: SessionWorksetState;
  attachedSkillIds: Iterable<string>;
  attachedToolNames: Iterable<string>;
  toolCalls: ToolCallState[];
}) {
  const nextState = cloneWorksetState(input.startingState);
  const turnCounter = nextState.turnCounter + 1;
  nextState.turnCounter = turnCounter;

  const attachedSkillIds = normalizeAttachedNames(input.attachedSkillIds);
  const attachedToolNames = normalizeAttachedNames(input.attachedToolNames);
  const attachedSkillSet = new Set(attachedSkillIds);
  const attachedToolSet = new Set(attachedToolNames);

  const usedToolCalls = input.toolCalls.filter((state) => isCountedToolCall(state));
  const usedToolNames = new Set(usedToolCalls.map((state) => state.toolName));
  const usedSkillIds = new Set<string>();

  for (const call of usedToolCalls) {
    for (const skillId of inferSkillIdsForToolCall(call.toolName, call.input, attachedSkillSet)) {
      usedSkillIds.add(skillId);
    }
  }

  const settleEntry = (
    entries: Record<string, WorksetEntryState>,
    key: string,
    isAttached: boolean,
    isUsed: boolean,
    wasActive: boolean,
  ) => {
    const entry = entries[key] ?? createWorksetEntryState();
    if (isAttached && !wasActive) {
      entry.idleTurns = 0;
      entry.score += 2;
      entry.active = true;
    }

    if (isAttached) {
      entry.lastAttachedTurn = turnCounter;
      if (isUsed) {
        entry.score += 1;
        entry.idleTurns = 0;
        entry.lastUsedTurn = turnCounter;
      } else {
        entry.score = Math.max(0, entry.score - 1);
        entry.idleTurns += 1;
      }

      if (entry.idleTurns >= 2 || entry.score <= 0) {
        entry.score = 0;
        entry.active = false;
      }
    }

    entries[key] = entry;
  };

  const skillKeys = new Set([
    ...Object.keys(nextState.skills),
    ...attachedSkillIds,
    ...usedSkillIds,
  ]);
  for (const skillId of skillKeys) {
    const wasActive = Boolean(input.startingState.skills[skillId]?.active);
    settleEntry(
      nextState.skills,
      skillId,
      attachedSkillSet.has(skillId),
      usedSkillIds.has(skillId),
      wasActive,
    );
  }

  const toolKeys = new Set([
    ...Object.keys(nextState.tools),
    ...attachedToolNames,
    ...usedToolNames,
  ]);
  for (const toolName of toolKeys) {
    const wasActive = Boolean(input.startingState.tools[toolName]?.active);
    settleEntry(
      nextState.tools,
      toolName,
      attachedToolSet.has(toolName),
      usedToolNames.has(toolName),
      wasActive,
    );
  }

  updateSessionWorksetState(input.sessionId, nextState);
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

function getRenderableAssistantText(providerId: string, value: string, final = false) {
  const sanitized = sanitizeAssistantTextForChat(value);
  const trimmed = sanitized.trimStart();
  if (!trimmed) {
    return sanitized;
  }

  if (!final && (/\[TOOL_CALL\]/iu.test(trimmed) || /<tool_call>/iu.test(trimmed))) {
    return null;
  }

  if (providerId !== "minimax" || final) {
    return sanitized;
  }

  const lowerTrimmed = trimmed.toLowerCase();
  const minimaxPrelude = "minimax:tool_call";

  if (minimaxPrelude.startsWith(lowerTrimmed)) {
    return null;
  }

  if (lowerTrimmed.startsWith(minimaxPrelude)) {
    return "";
  }

  return sanitized;
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

function buildMiniMaxToolFallbackPrompt(toolName: string, input: Record<string, unknown>, output: unknown) {
  return [
    `You previously attempted to call the tool "${toolName}" with input: ${summarizeUnknown(input, 400) ?? "{}"}`,
    `The tool returned: ${summarizeUnknown(output, 4000) ?? ""}`,
    "Answer the user's original request directly in normal prose.",
    "Do not emit XML, <tool> tags, or tool_call markup.",
  ].join("\n\n");
}

async function executeMiniMaxTextToolCallFallback(
  run: AgentRun,
  stateMachine: ToolStateMachine,
  reasoningEffort: ReasoningEffort,
  assistantText: string,
) {
  const parsed = repairTextToolCall(assistantText);
  if (!parsed) {
    return null;
  }

  const tool = run.context.tools[parsed.toolName] as { execute?: (input: unknown) => Promise<unknown> } | undefined;
  if (!tool || typeof tool.execute !== "function") {
    const availableTools = Object.keys(run.context.tools);
    const availablePreview = availableTools.slice(0, 12).join(", ");
    return {
      replacementText: [
        `MiniMax 尝试调用 \`${parsed.toolName}\`，但当前回合没有把这个工具加入工具集。`,
        availablePreview
          ? `当前已挂载的工具有：${availablePreview}${availableTools.length > 12 ? " 等" : ""}。`
          : "当前回合没有挂载任何可执行工具。",
      ].join("\n\n"),
      toolCallCount: 0,
      parsedMarkup: parsed.markup,
    };
  }

  const toolCallId = `minimax-fallback-${randomUUID()}`;
  stateMachine.start(toolCallId, parsed.toolName, parsed.input);
  stateMachine.markInputAvailable(toolCallId);

  const predictedRuntime = predictToolBackend(run.sessionId, parsed.toolName);
  publishRuntimeEvent(run.sessionId, "tool.call.started", {
    toolCallId,
    toolName: parsed.toolName,
    inputPreview: summarizeUnknown(parsed.input),
    backend: predictedRuntime.backend,
    tabId: predictedRuntime.tabId,
    state: "input-available",
    fallbackSource: "minimax_text_tool_call",
  });

  const toolStartedAt = nowMs();

  try {
    const output = await tool.execute(parsed.input);
    stateMachine.markOutputAvailable(toolCallId, output);
    stateMachine.complete(toolCallId);

    const browserPayload = extractBrowserToolPayload(output);
    publishRuntimeEvent(run.sessionId, "tool.call.completed", {
      toolCallId,
      toolName: parsed.toolName,
      success: true,
      resultPreview: summarizeUnknown(output),
      durationMs: roundMs(nowMs() - toolStartedAt),
      backend: browserPayload.backend ?? predictedRuntime.backend,
      tabId: browserPayload.tabId ?? predictedRuntime.tabId,
      state: "output-available",
      fallbackSource: "minimax_text_tool_call",
    });

    void maybePublishToolImageAttachment(
      run.sessionId,
      parsed.toolName,
      output,
      parsed.input,
    ).catch(() => {});

    let finalText = "";

    try {
      const followup = await generateText({
        model: createProviderModel(run.provider),
        system: run.context.systemPrompt,
        messages: [
          ...autoCompactMessages(run.context.messages, 8),
          {
            role: "assistant",
            content: assistantText,
          },
          {
            role: "user",
            content: buildMiniMaxToolFallbackPrompt(parsed.toolName, parsed.input, output),
          },
        ],
        providerOptions: buildAgentProviderOptions(run.provider, reasoningEffort),
        abortSignal: run.abortController.signal,
      });
      finalText = followup.text.trim();
    } catch {
      finalText = "";
    }

    if (!finalText) {
      finalText = [
        `已接住 MiniMax 的文本工具调用并执行了 \`${parsed.toolName}\`。`,
        summarizeUnknown(output, 4000) ?? "",
      ].filter(Boolean).join("\n\n");
    }

    return {
      replacementText: finalText,
      toolCallCount: 1,
      parsedMarkup: parsed.markup,
    };
  } catch (error) {
    stateMachine.markError(toolCallId, error);
    stateMachine.complete(toolCallId);

    publishRuntimeEvent(run.sessionId, "tool.call.completed", {
      toolCallId,
      toolName: parsed.toolName,
      success: false,
      resultPreview: summarizeUnknown(error),
      durationMs: roundMs(nowMs() - toolStartedAt),
      backend: predictedRuntime.backend,
      tabId: predictedRuntime.tabId,
      state: "output-error",
      fallbackSource: "minimax_text_tool_call",
    });

    return {
      replacementText: [
        `MiniMax 返回了文本形式的工具调用：${parsed.markup}`,
        `我尝试按 AI-native fallback 执行 \`${parsed.toolName}\`，但失败了：${error instanceof Error ? error.message : String(error)}`,
      ].join("\n\n"),
      toolCallCount: 1,
      parsedMarkup: parsed.markup,
    };
  }
}

interface CapabilityRecoveryRequest {
  additionalStickySkillIds: string[];
  additionalToolNames: string[];
  reason: string;
}

const MAX_CAPABILITY_RECOVERY_ATTEMPTS = 3;

function buildCapabilityRecoveryRequest(
  reason: string,
  input: {
    skillIds?: string[];
    toolNames?: string[];
  },
): CapabilityRecoveryRequest {
  return {
    additionalStickySkillIds: [...new Set([...(input.skillIds ?? []), "skill-search", "skill-hub"])],
    additionalToolNames: [...new Set(input.toolNames ?? [])],
    reason,
  };
}

function isRecoverableToolName(toolName: string) {
  return toolName === "bash"
    || toolName === "web_search"
    || toolName === "web_fetch"
    || toolName.startsWith("browser_")
    || toolName.startsWith("chrome_relay_");
}

function inferStickySkillsForToolName(toolName: string) {
  if (toolName === "web_search") {
    return ["web-search"];
  }

  if (toolName === "web_fetch") {
    return ["web-fetch"];
  }

  if (toolName.startsWith("browser_") || toolName.startsWith("chrome_relay_")) {
    return ["browser"];
  }

  return [];
}

function extractReferencedToolNameFromAssistantText(text: string) {
  const toolMatch = text.match(/\b(bash|web_search|web_fetch|browser_[a-z_]+|chrome_relay_[a-z_]+)\b/u);
  return toolMatch?.[1] ?? null;
}

function inferIntentDrivenRecoveryRequest(
  userMessage: string | null,
  attachedToolNames: string[],
): CapabilityRecoveryRequest | null {
  if (!userMessage) {
    return null;
  }

  const attached = new Set(attachedToolNames);

  if (
    /https?:\/\/|查一下|搜一下|搜索|查查|最新|今天|今日|news|latest|today|发布了什么|发了什么|fact-check|research/iu.test(userMessage)
    && (!attached.has("web_search") || !attached.has("web_fetch"))
  ) {
    const missingToolNames = ["web_search", "web_fetch"].filter((toolName) => !attached.has(toolName));
    return buildCapabilityRecoveryRequest("user_intent:research", {
      skillIds: ["web-search", "web-fetch"],
      toolNames: missingToolNames,
    });
  }

  if (
    /浏览器|browser|网页|页面|网站|打开|登录|扫码|截图|click|tab|chrome|b站|bilibili|x\.com|twitter|小红书/iu.test(userMessage)
    && !attachedToolNames.some((toolName) => toolName.startsWith("browser_") || toolName.startsWith("chrome_relay_"))
  ) {
    return buildCapabilityRecoveryRequest("user_intent:browser", {
      skillIds: ["browser"],
    });
  }

  if (
    /文件|文件夹|目录|回收站|缓存|cache|trash|workspace|ls\b|du\b|find\b|rm\b/iu.test(userMessage)
    && !attached.has("bash")
  ) {
    return buildCapabilityRecoveryRequest("user_intent:bash", {
      skillIds: ["file-manager"],
      toolNames: ["bash"],
    });
  }

  return null;
}

function looksLikeCapabilitySeekingReply(text: string) {
  return /我需要先(?:查看|查询|看看|搜索)|让我先(?:查看|查询|看看|搜索)|可用的 skill|需要通过 skill 路由|不是直接挂载的基座工具|工具集|没加载|未挂载|unavailable|not available/u.test(text);
}

function buildCapabilityFailureReply(
  userMessage: string | null,
  attachedToolNames: string[],
) {
  if (userMessage && /https?:\/\/|查一下|搜一下|搜索|查查|最新|今天|今日|news|latest|today|发布了什么|发了什么|fact-check|research/iu.test(userMessage)) {
    return "我这轮还没真正执行到搜索或网页读取，所以不能假装已经查过。你可以给我一个具体链接，我继续直接读；或者我下一轮继续按搜索链路重试。";
  }

  if (userMessage && /浏览器|browser|网页|页面|网站|打开|登录|扫码|截图|click|tab|chrome|b站|bilibili|x\.com|twitter|小红书/iu.test(userMessage)) {
    return "我这轮还没真正打开或操作页面，所以现在给不出可靠结果。你可以给我目标页面或账号链接，我下一轮直接走浏览器链路。";
  }

  if (attachedToolNames.includes("bash")) {
    return "我这轮还没真正执行到需要的命令，所以先不假装已经做完。你可以继续让我重试，或者把目标路径和操作说得更具体一点。";
  }

  return "我这轮还没真正执行到需要的能力，所以先不假装已经完成。你可以继续让我重试，或者给我更具体的链接、页面或路径。";
}

function inferCapabilityRecoveryRequest(
  userMessage: string | null,
  assistantText: string,
  attachedToolNames: string[],
  resolvedToolCallCount: number,
): CapabilityRecoveryRequest | null {
  if (resolvedToolCallCount > 0) {
    return null;
  }

  const attached = new Set(attachedToolNames);
  const repairedToolCall = repairTextToolCall(assistantText);
  if (
    repairedToolCall
    && isRecoverableToolName(repairedToolCall.toolName)
    && !attached.has(repairedToolCall.toolName)
  ) {
    return buildCapabilityRecoveryRequest(`missing_tool:${repairedToolCall.toolName}`, {
      skillIds: inferStickySkillsForToolName(repairedToolCall.toolName),
      toolNames: [repairedToolCall.toolName],
    });
  }

  const referencedToolName = extractReferencedToolNameFromAssistantText(assistantText);
  if (
    referencedToolName
    && isRecoverableToolName(referencedToolName)
    && !attached.has(referencedToolName)
    && /未挂载|没加载|不可用|unavailable|not available|skill 路由|通过 skill/u.test(assistantText)
  ) {
    return buildCapabilityRecoveryRequest(`referenced_missing_tool:${referencedToolName}`, {
      skillIds: inferStickySkillsForToolName(referencedToolName),
      toolNames: [referencedToolName],
    });
  }

  if (
    /我需要先(?:查看|查询|看看|搜索).*(?:skill|技能|工具)|让我先(?:查看|查询|看看|搜索).*(?:skill|技能|工具)|不是直接挂载的基座工具|需要通过 skill 路由|可用的 skill/u.test(assistantText)
  ) {
    return buildCapabilityRecoveryRequest("skill_discovery_needed", {
      toolNames: attached.has("bash") ? [] : ["bash"],
    });
  }

  return inferIntentDrivenRecoveryRequest(userMessage, attachedToolNames);
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
  reportCompleted(text: string, streamTimings: Record<string, number | string | null>): void;
  reportFailed(error: unknown): void;
  dispose(): void;
}

async function createAgentRun(sessionId: string, queueWaitMs: number, jobId: string): Promise<AgentRun | null> {
  const activeProvider = getActiveProviderConfig();

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

  const run: AgentRun = {
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
  };
}

async function executeStreamAttempt(
  run: AgentRun,
  existingAssistantMessageId?: string | null,
): Promise<StreamResult & { assistantMessageId: string | null; attachedToolNames: string[]; toolCalls: ToolCallState[] }> {
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
    messages: autoCompactMessages(run.context.messages, 8),
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

  const { text, timings, diagnostics, assistantMessageId } = await consumeTextStream(
    run,
    stream,
    stateMachine,
    runtimeSettings.reasoningEffort,
    requestStartedAt,
    existingAssistantMessageId ?? null,
  );
  return {
    text,
    timings: {
      streamSetupMs,
      ...timings,
    },
    diagnostics,
    assistantMessageId,
    attachedToolNames: Object.keys(run.context.tools),
    toolCalls: stateMachine.getAll(),
  };
}

async function executeStream(run: AgentRun): Promise<StreamResult> {
  let assistantMessageId: string | null = null;
  let lastResult: StreamResult | null = null;
  let finalResult: StreamResult | null = null;
  const startingWorksetState = getSessionWorksetState(run.sessionId);
  const accumulatedStickySkillIds = new Set<string>();
  const accumulatedToolNames = new Set<string>();
  const accumulatedAttachedSkillIds = new Set<string>();
  const accumulatedAttachedToolNames = new Set<string>();
  const accumulatedToolCalls: ToolCallState[] = [];
  const attemptedRecoveryReasons = new Set<string>();
  const latestUserMessage = getLatestUserMessage(run.sessionId);

  try {
    for (let attempt = 0; attempt < MAX_CAPABILITY_RECOVERY_ATTEMPTS; attempt += 1) {
      const result = await executeStreamAttempt(run, assistantMessageId);
      assistantMessageId = result.assistantMessageId;
      lastResult = {
        text: result.text,
        timings: result.timings,
        diagnostics: result.diagnostics,
      };

      for (const skillId of run.context.routedSkillIds) {
        accumulatedAttachedSkillIds.add(skillId);
      }
      for (const toolName of result.attachedToolNames) {
        accumulatedAttachedToolNames.add(toolName);
      }
      accumulatedToolCalls.push(...result.toolCalls);

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
      });
    }
  } finally {
    settleWorksetAfterTurn({
      sessionId: run.sessionId,
      startingState: startingWorksetState,
      attachedSkillIds: accumulatedAttachedSkillIds,
      attachedToolNames: accumulatedAttachedToolNames,
      toolCalls: accumulatedToolCalls,
    });
  }

  const fallbackResult = finalResult ?? lastResult ?? {
    text: "",
    timings: {},
    diagnostics: {
      resolvedToolCallCount: 0,
      providerMetadataPreview: null,
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
// consumeTextStream — stream delta → DB with debounce
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 80;

async function consumeTextStream(
  run: AgentRun,
  stream: Awaited<ReturnType<typeof streamText>>,
  stateMachine: ToolStateMachine,
  reasoningEffort: ReasoningEffort,
  requestStartedAt: number,
  existingAssistantMessageId: string | null,
): Promise<{
  text: string;
  assistantMessageId: string | null;
  timings: Record<string, number | null>;
  diagnostics: StreamResult["diagnostics"];
}> {
  let text = "";
  const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
  const routedSkillIds = run.context.routedSkillIds;
  let assistantMessageId: string | null = existingAssistantMessageId;
  let pendingFlush = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTokenMs: number | null = null;
  let resolvedToolCalls: unknown[] = [];
  const attachedToolNames = Object.keys(run.context.tools);
  let fallbackToolCallCount = 0;

  function getChatContent(final = false) {
    return getRenderableAssistantText(run.provider.id, text, final);
  }

  function flush() {
    if (!assistantMessageId || !pendingFlush) return;
    pendingFlush = false;
    const content = getChatContent();
    if (content === null) {
      return;
    }
    const updateResult = updateSessionMessage({
      sessionId: run.sessionId,
      messageId: assistantMessageId,
      content,
      eventPayload: buildAssistantEventPayload(routedSkillIds, attachedToolNames),
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
      const content = getChatContent();
      if (content === null || !content) {
        continue;
      }

      firstTokenMs = roundMs(nowMs() - requestStartedAt);
      // First delta: create the message immediately
      const messageResult = createSessionMessage({
        sessionId: run.sessionId,
        clientMessageId: assistantClientMessageId,
        deviceId: "runtime-agent",
        role: "assistant",
        content,
        attachmentIds: [],
        eventPayload: buildAssistantEventPayload(routedSkillIds, attachedToolNames),
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

  resolvedToolCalls = await stream.toolCalls;

  if (resolvedToolCalls.length === 0 && text.trim()) {
    const fallback = await executeMiniMaxTextToolCallFallback(
      run,
      stateMachine,
      reasoningEffort,
      text,
    );

    if (fallback) {
      fallbackToolCallCount = fallback.toolCallCount;
      text = fallback.replacementText;
    }
  }

  // Handle tool-only replies with no text
  if (!text.trim()) {
    if (resolvedToolCalls.length > 0) {
      text = `已完成 ${resolvedToolCalls.length} 次工具调用。`;
    }
  }

  const finalContent = getChatContent(true);

  if (assistantMessageId && typeof finalContent === "string") {
    const updateResult = updateSessionMessage({
      sessionId: run.sessionId,
      messageId: assistantMessageId,
      content: finalContent,
      eventPayload: buildAssistantEventPayload(routedSkillIds, attachedToolNames),
    });
    publishSessionEvent(updateResult.event);
  }

  // Handle late message creation (text appeared after stream end, or tool-only fallback)
  if (!assistantMessageId && finalContent) {
    const messageResult = createSessionMessage({
      sessionId: run.sessionId,
      clientMessageId: assistantClientMessageId,
      deviceId: "runtime-agent",
      role: "assistant",
      content: finalContent,
      attachmentIds: [],
      eventPayload: buildAssistantEventPayload(routedSkillIds, attachedToolNames),
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
    assistantMessageId,
    timings: {
      firstTokenMs,
      streamTotalMs: roundMs(nowMs() - requestStartedAt),
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
    diagnostics: {
      resolvedToolCallCount: Array.isArray(resolvedToolCalls) ? resolvedToolCalls.length + fallbackToolCallCount : fallbackToolCallCount,
      providerMetadataPreview: summarizeUnknown(metadata),
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

  if (!latestUserMessage) {
    return;
  }

  void (async () => {
    const distilled = await reflectOnTurn({
      userMessages,
      assistantResponse: text,
    });

    for (const memory of distilled.permanent) {
      try {
        await createMemory({
          content: memory.content,
          source: "auto",
          durability: "permanent",
          factKind: memory.factKind,
          factKey: memory.factKey,
          relatedTopics: memory.relatedTopics,
        });
      } catch {
        // A single fact write should not block the rest of the post-turn updates.
      }
    }

  })().catch(() => {
    // Summary refresh failure should not fail the user-visible turn.
  });
}

// ---------------------------------------------------------------------------
// Public API (unchanged exports)
// ---------------------------------------------------------------------------

export async function runAgent(sessionId: string) {
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
    const run = await createAgentRun(sessionId, queueWaitMs, queuedJobId);
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
