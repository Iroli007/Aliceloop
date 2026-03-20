import { previewShellOverview, shellOverviewRoute, type ShellOverview } from "@aliceloop/runtime-core";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const desktopDeviceStorageKey = "aliceloop-desktop-device-id";
const HEARTBEAT_INTERVAL_MS = 10_000;

export type ShellState =
  | {
      status: "loading";
      data: ShellOverview;
      runtimeStatus: string;
    }
  | {
      status: "ready";
      data: ShellOverview;
      runtimeStatus: string;
      source: "daemon" | "preview";
    }
  | {
      status: "error";
      data: ShellOverview;
      runtimeStatus: string;
      error: string;
    };

function getStableDesktopDeviceId() {
  if (typeof window === "undefined") {
    return "desktop-server";
  }

  const existing = window.localStorage.getItem(desktopDeviceStorageKey);
  if (existing) {
    return existing;
  }

  const next = `desktop-${crypto.randomUUID()}`;
  window.localStorage.setItem(desktopDeviceStorageKey, next);
  return next;
}

export function useShellData(): ShellState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [state, setState] = useState<ShellState>({
    status: "loading",
    data: previewShellOverview,
    runtimeStatus: "正在连接本地 runtime...",
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [{ daemonBaseUrl }, runtimePing] = await Promise.all([bridge.getAppMeta(), bridge.pingRuntime()]);
        setDaemonBaseUrl(daemonBaseUrl);

        const runtimeStatus = runtimePing.ok
          ? bridge.mode === "electron"
            ? "本地 runtime 在线"
            : "浏览器预览已连接本地 runtime"
          : runtimePing.message ?? "本地 runtime 未启动";

        const response = await fetch(`${daemonBaseUrl}${shellOverviewRoute}`);
        if (!response.ok) {
          throw new Error(`Failed to load shell overview (${response.status})`);
        }

        const data = (await response.json()) as ShellOverview;
        if (!cancelled) {
          setState({
            status: "ready",
            data,
            runtimeStatus,
            source: "daemon",
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            data: previewShellOverview,
            runtimeStatus: "使用预览数据渲染桌面壳",
            error: error instanceof Error ? error.message : "Unknown shell error",
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!daemonBaseUrl) {
      return;
    }

    const deviceId = getStableDesktopDeviceId();
    const label = bridge.mode === "electron" ? "Aliceloop Desktop" : "Aliceloop Web Preview";

    const heartbeat = async () => {
      try {
        await fetch(`${daemonBaseUrl}/api/runtime/presence/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId,
            deviceType: "desktop",
            label,
          }),
        });
      } catch {
        // Shell keeps rendering preview/overview data even when the daemon is down.
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => {
      void heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [bridge.mode, daemonBaseUrl]);

  return state;
}
