import { previewShellOverview, shellOverviewRoute, type ShellOverview } from "@aliceloop/runtime-core";
import { useEffect, useState } from "react";

type ShellState =
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

export function useShellData(): ShellState {
  const [state, setState] = useState<ShellState>({
    status: "loading",
    data: previewShellOverview,
    runtimeStatus: "正在连接本地 runtime...",
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [{ daemonBaseUrl }, runtimePing] = await Promise.all([
          window.aliceloopDesktop.getAppMeta(),
          window.aliceloopDesktop.pingRuntime(),
        ]);

        const runtimeStatus = runtimePing.ok
          ? "本地 runtime 在线"
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

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

