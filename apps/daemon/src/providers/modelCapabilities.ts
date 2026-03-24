import type { StoredProviderConfig } from "../repositories/providerRepository";

export interface ModelCapabilities {
  audioInput: boolean;
  imageInput: boolean;
}

function normalizeModelName(model: string | null | undefined) {
  return model?.trim().toLowerCase() ?? "";
}

function resolveEffectiveTransport(config: StoredProviderConfig) {
  if (config.transport !== "auto") {
    return config.transport;
  }

  if (normalizeModelName(config.model).startsWith("claude")) {
    return "anthropic" as const;
  }

  return "openai-compatible" as const;
}

export function deriveModelCapabilities(config: StoredProviderConfig | null): ModelCapabilities {
  if (!config?.apiKey) {
    return {
      audioInput: false,
      imageInput: false,
    };
  }

  const transport = resolveEffectiveTransport(config);
  return {
    // OpenAI-compatible stacks can usually expose a transcription path even when
    // the configured chat model itself is text-first, so treat this as audio-capable
    // and fall back on runtime errors if the gateway rejects it.
    audioInput: transport === "openai-compatible",
    imageInput: transport === "openai-compatible" || transport === "anthropic",
  };
}
