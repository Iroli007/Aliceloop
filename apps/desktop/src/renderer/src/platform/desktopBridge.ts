type DesktopMeta = {
  daemonBaseUrl: string;
  name: string;
  version: string;
  desktopCapabilities?: unknown;
  publicPaths?: {
    publicRootDir: string;
    workspaceDir: string;
    skillsDir: string;
    scriptsDir: string;
    chromeExtensionDir: string;
  };
};

type RuntimePing = {
  ok: boolean;
  message?: string;
  service?: string;
  timestamp?: string;
  activeSkills?: string[];
  activeSkillAdapters?: string[];
};

export type DesktopPickedFile = {
  kind: "file";
  name: string;
  path: string;
  mimeType: string;
  contentBase64: string;
};

export type DesktopPickedFolderFile = {
  name: string;
  relativePath: string;
  mimeType: string;
  contentBase64: string;
};

export type DesktopPickedFolder = {
  kind: "folder";
  name: string;
  path: string;
  files: DesktopPickedFolderFile[];
};

export type DesktopPickerResult = {
  canceled: boolean;
  entries: Array<DesktopPickedFile | DesktopPickedFolder>;
};

export type DesktopOpenPathResult = {
  ok: boolean;
  error?: string;
};

type DesktopBridge = {
  getAppMeta(): Promise<DesktopMeta>;
  pingRuntime(): Promise<RuntimePing>;
  openFileOrFolder(): Promise<DesktopPickerResult>;
  openPath(path: string): Promise<DesktopOpenPathResult>;
  closeWindow(): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleFullscreenWindow(): Promise<void>;
  openSettings(): Promise<void>;
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

        return await response.json();
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Daemon unavailable",
        };
      }
    },
    async openFileOrFolder() {
      return {
        canceled: true,
        entries: [],
      };
    },
    async openPath() {
      return {
        ok: false,
        error: "Web Preview 不支持打开本地目录",
      };
    },
    async closeWindow() {
      window.close();
    },
    async minimizeWindow() {
      return;
    },
    async toggleFullscreenWindow() {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await document.documentElement.requestFullscreen?.();
    },
    async openSettings() {
      return;
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
