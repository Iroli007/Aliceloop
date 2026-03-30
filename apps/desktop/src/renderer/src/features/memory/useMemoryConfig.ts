import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

export interface SaveMemoryConfigInput {
  enabled?: boolean;
  queryRewrite?: boolean;
  embeddingModel?: MemoryConfig["embeddingModel"];
  embeddingDimension?: number;
}

export interface MemoryConfigState {
  status: "loading" | "ready" | "error";
  config: MemoryConfig;
  saving: boolean;
  rebuilding: boolean;
  error?: string;
  save(input: SaveMemoryConfigInput): Promise<{ ok: boolean; config?: MemoryConfig; error?: string }>;
  rebuild(): Promise<{ ok: boolean; error?: string }>;
}

export function useMemoryConfig(): MemoryConfigState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [config, setConfig] = useState<MemoryConfig>(DEFAULT_MEMORY_CONFIG);
  const [status, setStatus] = useState<MemoryConfigState["status"]>("loading");
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl } = await bridge.getAppMeta();
        const response = await fetch(`${daemonBaseUrl}/api/memory/config`);
        if (!response.ok) {
          throw new Error(`Failed to load memory config (${response.status})`);
        }

        const nextConfig = (await response.json()) as MemoryConfig;
        if (!cancelled) {
          setConfig(nextConfig);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setConfig(DEFAULT_MEMORY_CONFIG);
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load memory config");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function save(input: SaveMemoryConfigInput) {
    setSaving(true);

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/memory/config`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`Failed to save memory config (${response.status})`);
      }

      const nextConfig = (await response.json()) as MemoryConfig;
      setConfig(nextConfig);
      setStatus("ready");
      setError(undefined);
      return {
        ok: true as const,
        config: nextConfig,
      };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Failed to save memory config";
      setError(message);
      return {
        ok: false as const,
        error: message,
      };
    } finally {
      setSaving(false);
    }
  }

  async function rebuild() {
    setRebuilding(true);

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/memory/rebuild`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to rebuild memory embeddings (${response.status})`);
      }

      setError(undefined);
      return {
        ok: true as const,
      };
    } catch (rebuildError) {
      const message = rebuildError instanceof Error ? rebuildError.message : "Failed to rebuild memory embeddings";
      setError(message);
      return {
        ok: false as const,
        error: message,
      };
    } finally {
      setRebuilding(false);
    }
  }

  return {
    status,
    config,
    saving,
    rebuilding,
    error,
    save,
    rebuild,
  };
}
