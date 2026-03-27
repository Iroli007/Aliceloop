import type { BrowserRelayCapability } from "@aliceloop/runtime-core";

export {};

declare global {
  interface Window {
    aliceloopDesktop?: {
      getAppMeta(): Promise<{
        daemonBaseUrl: string;
        name: string;
        version: string;
        desktopCapabilities?: {
          browserRelay?: BrowserRelayCapability;
        };
      }>;
      pingRuntime(): Promise<{
        ok: boolean;
        message?: string;
        service?: string;
        timestamp?: string;
        activeSkills?: string[];
        activeSkillAdapters?: string[];
      }>;
      openFileOrFolder(): Promise<{
        canceled: boolean;
        entries: Array<
          | {
              kind: "file";
              name: string;
              path: string;
              mimeType: string;
              contentBase64: string;
            }
          | {
              kind: "folder";
              name: string;
              path: string;
              files: Array<{
                name: string;
                relativePath: string;
                mimeType: string;
                contentBase64: string;
              }>;
          }
        >;
      }>;
      openPath(path: string): Promise<{
        ok: boolean;
        error?: string;
      }>;
      closeWindow(): Promise<void>;
      minimizeWindow(): Promise<void>;
      toggleFullscreenWindow(): Promise<void>;
      openSettings(): Promise<void>;
      openChromeRelay(): Promise<void>;
      getChromeRelayState(): Promise<{
        browserRelay: BrowserRelayCapability | null;
        attachedTabs: number;
      } | null>;
      regenerateChromeRelayToken(): Promise<{
        browserRelay: BrowserRelayCapability | null;
        attachedTabs: number;
      } | null>;
      launchChromeRelay(): Promise<{
        browserRelay: BrowserRelayCapability | null;
        attachedTabs: number;
      } | null>;
    };
  }

  interface ImportMetaEnv {
    readonly VITE_DAEMON_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
