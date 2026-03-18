import { type ProviderConfig, type ProviderKind } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const previewProviderConfigs: ProviderConfig[] = [
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.5",
    enabled: false,
    hasApiKey: false,
    apiKeyMasked: null,
    updatedAt: null,
  },
];

interface SaveProviderInput {
  providerId: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
}

export interface ProviderConfigsState {
  status: "loading" | "ready" | "error";
  providers: ProviderConfig[];
  savingProviderId: ProviderKind | null;
  error?: string;
  save(input: SaveProviderInput): Promise<{ ok: boolean; config?: ProviderConfig; error?: string }>;
}

export function useProviderConfigs(): ProviderConfigsState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [providers, setProviders] = useState<ProviderConfig[]>(previewProviderConfigs);
  const [status, setStatus] = useState<ProviderConfigsState["status"]>("loading");
  const [savingProviderId, setSavingProviderId] = useState<ProviderKind | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl } = await bridge.getAppMeta();
        const response = await fetch(`${daemonBaseUrl}/api/providers`);
        if (!response.ok) {
          throw new Error(`Failed to load provider configs (${response.status})`);
        }

        const nextProviders = (await response.json()) as ProviderConfig[];
        if (!cancelled) {
          setProviders(nextProviders.length > 0 ? nextProviders : previewProviderConfigs);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load provider configs");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function save(input: SaveProviderInput) {
    setSavingProviderId(input.providerId);

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/providers/${input.providerId}`, {
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
        throw new Error(`Failed to save ${input.providerId} config (${response.status})`);
      }

      const nextConfig = (await response.json()) as ProviderConfig;
      setProviders((current) => {
        const hasCurrent = current.some((provider) => provider.id === nextConfig.id);
        if (!hasCurrent) {
          return [...current, nextConfig];
        }

        return current.map((provider) => (provider.id === nextConfig.id ? nextConfig : provider));
      });
      setStatus("ready");
      setError(undefined);
      return {
        ok: true as const,
        config: nextConfig,
      };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Failed to save provider config";
      setError(message);
      return {
        ok: false as const,
        error: message,
      };
    } finally {
      setSavingProviderId(null);
    }
  }

  return {
    status,
    providers,
    savingProviderId,
    error,
    save,
  };
}
