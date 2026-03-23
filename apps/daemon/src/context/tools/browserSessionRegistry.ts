import type { BrowserRelayCapability } from "@aliceloop/runtime-core";
import { getHealthyBrowserRelayDevice } from "../../repositories/sessionRepository";
import type { BrowserBackendKind, BrowserSessionRecord } from "./browserTypes";

const sessions = new Map<string, BrowserSessionRecord>();

function getHealthyBrowserRelayCapability(): BrowserRelayCapability | null {
  return getHealthyBrowserRelayDevice()?.capabilities?.browserRelay ?? null;
}

function applyRelayCapability(session: BrowserSessionRecord, relay: BrowserRelayCapability) {
  session.backend = "desktop_chrome";
  session.relayBaseUrl = relay.baseUrl;
  session.relayToken = relay.token;
}

export function getBrowserSession(sessionId: string): BrowserSessionRecord {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      backend: null,
      tabId: null,
      relayBaseUrl: null,
      relayToken: null,
    };
    sessions.set(sessionId, session);
  }

  return session;
}

export function resolveBrowserSession(sessionId: string): BrowserSessionRecord {
  const session = getBrowserSession(sessionId);
  if (session.backend === "desktop_chrome" && session.relayBaseUrl && session.relayToken) {
    return session;
  }

  if (session.backend === "playwright") {
    return session;
  }

  const relay = getHealthyBrowserRelayCapability();
  if (relay) {
    applyRelayCapability(session, relay);
    return session;
  }

  session.backend = "playwright";
  session.relayBaseUrl = null;
  session.relayToken = null;
  return session;
}

export function refreshDesktopRelaySession(session: BrowserSessionRecord): BrowserSessionRecord | null {
  const relay = getHealthyBrowserRelayCapability();
  if (!relay) {
    return null;
  }

  applyRelayCapability(session, relay);
  return session;
}

export function previewBrowserRuntime(
  sessionId: string,
): { backend: BrowserBackendKind; tabId: string | null } {
  const session = sessions.get(sessionId);
  if (session?.backend === "desktop_chrome" && session.relayBaseUrl && session.relayToken) {
    return {
      backend: "desktop_chrome",
      tabId: session.tabId,
    };
  }

  if (session?.backend === "playwright") {
    return {
      backend: "playwright",
      tabId: session.tabId,
    };
  }

  const relay = getHealthyBrowserRelayCapability();
  return {
    backend: relay ? "desktop_chrome" : "playwright",
    tabId: session?.tabId ?? null,
  };
}

export function clearBrowserSession(sessionId: string) {
  sessions.delete(sessionId);
}
