export {};

declare global {
  interface Window {
    aliceloopDesktop: {
      getAppMeta(): Promise<{
        daemonBaseUrl: string;
        name: string;
        version: string;
      }>;
      pingRuntime(): Promise<{
        ok: boolean;
        message?: string;
      }>;
    };
  }
}

