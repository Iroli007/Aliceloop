export {};

declare global {
  interface Window {
    aliceloopDesktop?: {
      getAppMeta(): Promise<{
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
    };
  }

  interface ImportMetaEnv {
    readonly VITE_DAEMON_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
