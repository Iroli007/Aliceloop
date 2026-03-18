type DesktopMeta = {
  daemonBaseUrl: string;
  name: string;
  version: string;
};

type RuntimePing = {
  ok: boolean;
  message?: string;
};

type DesktopBridge = {
  getAppMeta(): Promise<DesktopMeta>;
  pingRuntime(): Promise<RuntimePing>;
  mode: "electron" | "web-preview";
};

const defaultDaemonBaseUrl = import.meta.env.VITE_DAEMON_URL ?? "http://127.0.0.1:3030";

function createBrowserBridge(): DesktopBridge {
  return {
    mode: "web-preview",
    async getAppMeta() {
      return {
        daemonBaseUrl: defaultDaemonBaseUrl,
        name: "Aliceloop",
        version: "web-preview",
      };
    },
    async pingRuntime() {
      try {
        const response = await fetch(`${defaultDaemonBaseUrl}/health`);
        if (!response.ok) {
          return {
            ok: false,
            message: `HTTP ${response.status}`,
          };
        }

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Daemon unavailable",
        };
      }
    },
  };
}

export function getDesktopBridge(): DesktopBridge {
  if (window.aliceloopDesktop) {
    return {
      ...window.aliceloopDesktop,
      mode: "electron",
    };
  }

  return createBrowserBridge();
}

export type { DesktopBridge, DesktopMeta, RuntimePing };
