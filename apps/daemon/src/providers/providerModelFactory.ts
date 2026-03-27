import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { StoredProviderConfig } from "../repositories/providerRepository";

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

export function createProviderModel(config: StoredProviderConfig) {
  const effectiveTransport = resolveEffectiveTransport(config);
  const baseUrl = normalizeGatewayBaseUrl(config.baseUrl, effectiveTransport === "anthropic");
  switch (effectiveTransport) {
    case "anthropic": {
      const provider = createAnthropic({
        baseURL: baseUrl,
        apiKey: config.apiKey ?? "",
      });
      return provider(config.model);
    }
    default: {
      const provider = createOpenAI({
        baseURL: baseUrl,
        apiKey: config.apiKey ?? "",
      });
      return provider(config.model);
    }
  }
}
