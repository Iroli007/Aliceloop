export {};

declare module "react" {
  interface InputHTMLAttributes<T> {
    directory?: string;
    webkitdirectory?: string;
  }
}

declare global {
  interface Window {
    aliceloopDesktop?: {
      getAppMeta(): Promise<{
        daemonBaseUrl: string;
        name: string;
        version: string;
      }>;
      pingRuntime(): Promise<{
        ok: boolean;
        message?: string;
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
      minimizeWindow(): Promise<void>;
      toggleMaximizeWindow(): Promise<void>;
    };
  }

  interface ImportMetaEnv {
    readonly VITE_DAEMON_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
