import { type ProviderConfig } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const previewMiniMaxConfig: ProviderConfig = {
  id: "minimax",
  label: "MiniMax",
  baseUrl: "https://api.minimax.io/v1",
  model: "MiniMax-M2.1",
  enabled: false,
  hasApiKey: false,
  apiKeyMasked: null,
  updatedAt: null,
};

interface SaveMiniMaxInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
}

export interface MiniMaxProviderState {
  status: "loading" | "ready" | "error";
  config: ProviderConfig;
  saving: boolean;
  error?: string;
  save(input: SaveMiniMaxInput): Promise<{ ok: boolean; error?: string }>;
}

export function useMiniMaxProvider(): MiniMaxProviderState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [config, setConfig] = useState<ProviderConfig>(previewMiniMaxConfig);
  const [status, setStatus] = useState<MiniMaxProviderState["status"]>("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl } = await bridge.getAppMeta();
        const response = await fetch(`${daemonBaseUrl}/api/providers/minimax`);
        if (!response.ok) {
          throw new Error(`Failed to load MiniMax config (${response.status})`);
        }

        const nextConfig = (await response.json()) as ProviderConfig;
        if (!cancelled) {
          setConfig(nextConfig);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load MiniMax config");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function save(input: SaveMiniMaxInput) {
    setSaving(true);

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/providers/minimax`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey,
          enabled: input.enabled,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save MiniMax config (${response.status})`);
      }

      const nextConfig = (await response.json()) as ProviderConfig;
      setConfig(nextConfig);
      setStatus("ready");
      setError(undefined);
      return { ok: true as const };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Failed to save MiniMax config";
      setError(message);
      return { ok: false as const, error: message };
    } finally {
      setSaving(false);
    }
  }

  return {
    status,
    config,
    saving,
    error,
    save,
  };
}
