import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { StoredProviderConfig } from "../repositories/providerRepository";

export function createProviderModel(config: StoredProviderConfig) {
  switch (config.transport) {
    case "anthropic": {
      const provider = createAnthropic({
        baseURL: config.baseUrl.replace(/\/+$/, ""),
        apiKey: config.apiKey ?? "",
      });
      return provider(config.model);
    }
    case "openai-compatible":
    default: {
      const provider = createOpenAI({
        baseURL: config.baseUrl.replace(/\/+$/, ""),
        apiKey: config.apiKey ?? "",
      });
      return provider(config.model);
    }
  }
}
