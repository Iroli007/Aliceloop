import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { StoredProviderConfig } from "../repositories/providerRepository";
import { normalizeProviderBaseUrl, resolveProviderTransport } from "./providerProfile";

export function createProviderModel(config: StoredProviderConfig) {
  const effectiveTransport = resolveProviderTransport(config);
  const baseUrl = normalizeProviderBaseUrl(config.baseUrl, effectiveTransport);
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
