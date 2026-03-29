import type { BrowserRelayCapability } from "@aliceloop/runtime-core";
import { getDaemonChromeRelayCapability } from "../../services/chromeRelayManager";
import type { BrowserBackendKind, BrowserSessionRecord } from "./browserTypes";
import { pinchTabAvailable } from "./pinchTabBrowserBackend";

const sessions = new Map<string, BrowserSessionRecord>();

function getHealthyBrowserRelayCapability(): BrowserRelayCapability | null {
  return getDaemonChromeRelayCapability();
}

function applyRelayCapability(session: BrowserSessionRecord, relay: BrowserRelayCapability) {
  session.backend = "desktop_chrome";
  session.relayBaseUrl = relay.baseUrl;
}

function applyPinchTabCapability(session: BrowserSessionRecord) {
  session.backend = "pinchtab";
  session.relayBaseUrl = null;
}

function clearResolvedBackend(session: BrowserSessionRecord) {
  session.backend = null;
  session.tabId = null;
  session.relayBaseUrl = null;
}

export function getBrowserSession(sessionId: string): BrowserSessionRecord {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      backend: null,
      preferredBackend: null,
      tabId: null,
      relayBaseUrl: null,
    };
    sessions.set(sessionId, session);
  }

  return session;
}

export function setBrowserSessionPreference(
  sessionId: string,
  preferredBackend: BrowserBackendKind | null,
) {
  const session = getBrowserSession(sessionId);
  if (session.preferredBackend && preferredBackend && session.preferredBackend !== preferredBackend) {
    clearResolvedBackend(session);
  }
  session.preferredBackend = preferredBackend;
}

export function resolveBrowserSession(sessionId: string): BrowserSessionRecord {
  const session = getBrowserSession(sessionId);
  if (session.backend === "desktop_chrome" && session.relayBaseUrl) {
    return session;
  }

  if (session.backend === "pinchtab" && pinchTabAvailable()) {
    return session;
  }

  const relay = getHealthyBrowserRelayCapability();
  const preferredBackend = session.preferredBackend ?? (relay ? "desktop_chrome" : "pinchtab");

  if (preferredBackend === "desktop_chrome" && relay) {
    applyRelayCapability(session, relay);
    return session;
  }

  if (pinchTabAvailable()) {
    applyPinchTabCapability(session);
    return session;
  }

  if (preferredBackend === "desktop_chrome") {
    throw new Error("browser_runtime_unavailable: Aliceloop Desktop Chrome relay is required for this turn but is not ready.");
  }

  throw new Error("browser_runtime_unavailable: PinchTab is not ready. Chrome relay stays in compatibility mode and must be explicitly requested.");
}

export function refreshDesktopRelaySession(session: BrowserSessionRecord): BrowserSessionRecord | null {
  const relay = getHealthyBrowserRelayCapability();
  if (!relay) {
    return null;
  }

  applyRelayCapability(session, relay);
  return session;
}

export function resolveDesktopRelaySession(sessionId: string): BrowserSessionRecord {
  const session = getBrowserSession(sessionId);
  if (session.backend === "desktop_chrome" && session.relayBaseUrl) {
    return session;
  }

  const relay = getHealthyBrowserRelayCapability();
  if (!relay) {
    throw new Error("No healthy Aliceloop Desktop Chrome relay is registered.");
  }

  applyRelayCapability(session, relay);
  return session;
}

export function previewBrowserRuntime(
  sessionId: string,
): { backend: BrowserBackendKind; tabId: string | null } {
  const session = sessions.get(sessionId);
  if (session?.backend === "desktop_chrome" && session.relayBaseUrl) {
    return {
      backend: "desktop_chrome",
      tabId: session.tabId,
    };
  }

  if (session?.backend === "pinchtab") {
    return {
      backend: "pinchtab",
      tabId: session.tabId,
    };
  }

  const relay = getHealthyBrowserRelayCapability();
  const preferredBackend = session?.preferredBackend ?? (relay ? "desktop_chrome" : "pinchtab");
  return {
    backend: preferredBackend === "desktop_chrome"
      ? relay
        ? "desktop_chrome"
        : "pinchtab"
      : pinchTabAvailable()
        ? "pinchtab"
        : (relay ? "desktop_chrome" : "pinchtab"),
    tabId: session?.tabId ?? null,
  };
}

export function clearBrowserSession(sessionId: string) {
  sessions.delete(sessionId);
}
