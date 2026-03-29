import type { BrowserRelayCapability } from "@aliceloop/runtime-core";
import { ChromeRelayBridgeServer } from "../../../desktop/src/main/chromeRelayBridgeServer";

type BrowserStackState = {
  preferredBackend: "opencli" | "pinchtab" | "desktop_chrome" | "none";
  opencli: {
    available: boolean;
    healthy: boolean;
    version: string | null;
    daemonPort: number | null;
    extensionConnected: boolean;
    extensionVersion: string | null;
    detail: string;
  };
  pinchTab: {
    available: boolean;
    healthy: boolean;
    version: string | null;
    mode: string | null;
    detail: string;
  };
  relay: {
    bridgeRelay: BrowserRelayCapability | null;
    bridgeAttachedTabs: number;
    runtimeRelay: BrowserRelayCapability | null;
    runtimeAttachedTabs: number;
  };
};

let chromeRelayBridgeServer: ChromeRelayBridgeServer | null = null;
const chromeRelayPort = Number(process.env.ALICELOOP_CHROME_RELAY_PORT ?? 23001);

function collectRelayState() {
  const bridgeStatus = chromeRelayBridgeServer?.getMeta() ?? null;

  return {
    bridgeRelay: bridgeStatus?.browserRelay ?? null,
    bridgeAttachedTabs: bridgeStatus?.attachedTabs ?? 0,
    runtimeRelay: bridgeStatus?.browserRelay ?? null,
    runtimeAttachedTabs: bridgeStatus?.attachedTabs ?? 0,
  };
}

export async function ensureDaemonChromeRelayStarted() {
  if (!chromeRelayBridgeServer) {
    chromeRelayBridgeServer = new ChromeRelayBridgeServer(chromeRelayPort);
  }

  await chromeRelayBridgeServer.start();
}

export async function stopDaemonChromeRelay() {
  const bridgeServer = chromeRelayBridgeServer;

  chromeRelayBridgeServer = null;

  await Promise.all([
    bridgeServer?.stop().catch(() => undefined),
  ]);
}

export async function launchDaemonChromeRelay() {
  await ensureDaemonChromeRelayStarted();
  return getDaemonChromeRelayBrowserStackState();
}

export function getDaemonChromeRelayCapability() {
  return chromeRelayBridgeServer?.getMeta()?.browserRelay ?? null;
}

export function hasHealthyDaemonChromeRelay() {
  const relay = getDaemonChromeRelayCapability();
  return Boolean(relay?.enabled && relay.healthy);
}

export function getDaemonChromeRelayBrowserStackState(): BrowserStackState {
  const relay = collectRelayState();

  return {
    preferredBackend: relay.runtimeRelay?.healthy ? "desktop_chrome" : "none",
    opencli: {
      available: false,
      healthy: false,
      version: null,
      daemonPort: null,
      extensionConnected: false,
      extensionVersion: null,
      detail: "由 daemon 托管，桌面端不再直接检测。",
    },
    pinchTab: {
      available: false,
      healthy: false,
      version: null,
      mode: null,
      detail: "由 daemon 托管，桌面端不再直接检测。",
    },
    relay,
  };
}
