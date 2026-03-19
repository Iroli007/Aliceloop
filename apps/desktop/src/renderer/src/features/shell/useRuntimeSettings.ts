import {
  defaultRuntimeSettings,
  type RuntimeSettings,
  type SandboxPermissionProfile,
} from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

interface SaveRuntimeSettingsInput {
  sandboxProfile: SandboxPermissionProfile;
}

export interface RuntimeSettingsState {
  status: "loading" | "ready" | "error";
  settings: RuntimeSettings;
  saving: boolean;
  error?: string;
  save(input: SaveRuntimeSettingsInput): Promise<{ ok: boolean; settings?: RuntimeSettings; error?: string }>;
}

export function useRuntimeSettings(): RuntimeSettingsState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [settings, setSettings] = useState<RuntimeSettings>(defaultRuntimeSettings);
  const [status, setStatus] = useState<RuntimeSettingsState["status"]>("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl } = await bridge.getAppMeta();
        const response = await fetch(`${daemonBaseUrl}/api/runtime/settings`);
        if (!response.ok) {
          throw new Error(`Failed to load runtime settings (${response.status})`);
        }

        const nextSettings = (await response.json()) as RuntimeSettings;
        if (!cancelled) {
          setSettings(nextSettings);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setSettings(defaultRuntimeSettings);
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load runtime settings");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function save(input: SaveRuntimeSettingsInput) {
    setSaving(true);

    try {
      const { daemonBaseUrl } = await bridge.getAppMeta();
      const response = await fetch(`${daemonBaseUrl}/api/runtime/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sandboxProfile: input.sandboxProfile,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save runtime settings (${response.status})`);
      }

      const nextSettings = (await response.json()) as RuntimeSettings;
      setSettings(nextSettings);
      setStatus("ready");
      setError(undefined);
      return {
        ok: true as const,
        settings: nextSettings,
      };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Failed to save runtime settings";
      setError(message);
      return {
        ok: false as const,
        error: message,
      };
    } finally {
      setSaving(false);
    }
  }

  return {
    status,
    settings,
    saving,
    error,
    save,
  };
}
