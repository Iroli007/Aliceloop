import type { ReasoningEffort } from "@aliceloop/runtime-core";
import type { StoredProviderConfig } from "../repositories/providerRepository";

function normalizeReasoningModelId(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

export function resolveProviderTransport(config: StoredProviderConfig) {
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

export function buildAgentProviderOptions(config: StoredProviderConfig, reasoningEffort: ReasoningEffort) {
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

export function getRenderableAssistantText(providerId: string, value: string, final = false) {
  const sanitized = sanitizeAssistantTextForChat(value);
  if (providerId !== "minimax") {
    return sanitized;
  }

  const trimmed = sanitized.trimStart();
  if (!trimmed || final) {
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
