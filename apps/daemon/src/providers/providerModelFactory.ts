import { createAnthropic } from "@ai-sdk/anthropic";
import { AnthropicMessagesLanguageModel } from "@ai-sdk/anthropic/internal";
import { createOpenAI } from "@ai-sdk/openai";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import type { StoredProviderConfig } from "../repositories/providerRepository";
import { shouldEnableProviderThinking } from "../runtime/providerRuntimeAdapter";
import { createAnthropicCacheEditingTransform } from "./anthropicCacheEditing";
import { createDeepSeekThinkingFetch } from "./deepseekThinkingBridge";

function normalizeGatewayBaseUrl(baseUrl: string, useAnthropicTransport: boolean) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (useAnthropicTransport && trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/messages".length);
  }

  if (useAnthropicTransport && trimmed.endsWith("/v1")) {
    return trimmed;
  }

  if (useAnthropicTransport) {
    return `${trimmed}/v1`;
  }

  return trimmed;
}

function resolveEffectiveTransport(config: StoredProviderConfig) {
  if (config.transport !== "auto") {
    return config.transport;
  }

  if (config.model.trim().toLowerCase().startsWith("claude")) {
    return "anthropic";
  }

  return "openai-compatible";
}

export function createProviderModel(
  config: StoredProviderConfig,
  options?: {
    sessionId?: string;
    enablePromptCacheEditing?: boolean;
    reasoningEffort?: ReasoningEffort;
  },
) {
  const effectiveTransport = resolveEffectiveTransport(config);
  const baseUrl = normalizeGatewayBaseUrl(config.baseUrl, effectiveTransport === "anthropic");
  const anthropicBaseUrl = baseUrl || "https://api.anthropic.com/v1";
  switch (effectiveTransport) {
    case "anthropic": {
      if (options?.enablePromptCacheEditing) {
        return new AnthropicMessagesLanguageModel(config.model, {
          provider: "anthropic.messages",
          baseURL: anthropicBaseUrl,
          headers: {
            "anthropic-version": "2023-06-01",
            "x-api-key": config.apiKey ?? "",
          },
          supportedUrls: () => ({
            "image/*": [/^https?:\/\/.*$/],
            "application/pdf": [/^https?:\/\/.*$/],
          }),
          transformRequestBody: createAnthropicCacheEditingTransform({
            sessionId: options.sessionId,
          }),
        });
      }

      const provider = createAnthropic({
        baseURL: anthropicBaseUrl,
        apiKey: config.apiKey ?? "",
      });
      return provider(config.model);
    }
    default: {
      const provider = createOpenAI({
        baseURL: baseUrl,
        apiKey: config.apiKey ?? "",
        fetch: config.id === "deepseek"
          ? createDeepSeekThinkingFetch({
              sessionId: options?.sessionId,
              providerId: config.id,
              model: config.model,
              reasoningEffort: options?.reasoningEffort,
              thinkingEnabled: shouldEnableProviderThinking(config, options?.reasoningEffort ?? "off"),
            })
          : undefined,
      });
      return config.id === "openai" ? provider(config.model) : provider.chat(config.model);
    }
  }
}
