import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { StoredProviderConfig } from "../repositories/providerRepository";

function normalizeGatewayBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/messages".length);
  }

  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }

  return `${trimmed}/v1`;
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
  const baseUrl = normalizeGatewayBaseUrl(config.baseUrl);
  switch (resolveEffectiveTransport(config)) {
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
