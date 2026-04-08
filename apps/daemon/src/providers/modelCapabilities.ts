import type { StoredProviderConfig } from "../repositories/providerRepository";
import { resolveProviderTransport } from "./providerProfile";

export interface ModelCapabilities {
  audioInput: boolean;
  imageInput: boolean;
}

export function deriveModelCapabilities(config: StoredProviderConfig | null): ModelCapabilities {
  if (!config?.apiKey) {
    return {
      audioInput: false,
      imageInput: false,
    };
  }

  const transport = resolveProviderTransport(config);
  return {
    // OpenAI-compatible stacks can usually expose a transcription path even when
    // the configured chat model itself is text-first, so treat this as audio-capable
    // and fall back on runtime errors if the gateway rejects it.
    audioInput: transport === "openai-compatible",
    imageInput: transport === "openai-compatible" || transport === "anthropic",
  };
}
