import type { BrowserRelayCapability } from "@aliceloop/runtime-core";
import { getDaemonChromeRelayCapability, hasHealthyDaemonChromeRelay } from "../../services/chromeRelayManager";

export interface DesktopRelayReadablePayload {
  url: string;
  title: string;
  publishedAt: string | null;
  modifiedAt: string | null;
  pageText: string;
  backend: "desktop_chrome";
  tabId: string;
}

export interface DesktopRelaySearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface DesktopRelaySearchPayload {
  url: string;
  backend: "desktop_chrome";
  tabId: string;
  results: DesktopRelaySearchResult[];
}

interface ResearchTabRecord {
  tabId: string;
  relayBaseUrl: string;
  lastUsedAt: number;
}

const researchTabs = new Map<string, ResearchTabRecord>();
const RESEARCH_TAB_TTL_MS = 2 * 60 * 1000;

function getHealthyBrowserRelayCapability(): BrowserRelayCapability | null {
  const relay = getDaemonChromeRelayCapability();
  return relay?.enabled && relay.healthy ? relay : null;
}

async function requestRelay<T>(
  relay: BrowserRelayCapability,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${relay.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    detail?: unknown;
  } | null;

  if (!response.ok) {
    const detail = typeof payload?.detail === "string"
      ? payload.detail
      : typeof payload?.error === "string"
        ? payload.error
        : `Desktop relay request failed (${response.status})`;
    throw new Error(detail);
  }

  return payload as T;
}

async function openRelayTab(relay: BrowserRelayCapability) {
  const payload = await requestRelay<{ tabId?: unknown }>(relay, "/tabs/open", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const tabId = typeof payload.tabId === "string" ? payload.tabId : null;
  if (!tabId) {
    throw new Error("Desktop relay did not return a tab id.");
  }

  return tabId;
}

async function closeRelayTab(relay: BrowserRelayCapability, tabId: string) {
  await requestRelay(relay, `/tabs/${encodeURIComponent(tabId)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

async function closeStaleResearchTabs(activeRelay: BrowserRelayCapability | null, now = Date.now()) {
  for (const [sessionId, tab] of researchTabs) {
    const relayChanged = !activeRelay || tab.relayBaseUrl !== activeRelay.baseUrl;
    const stale = now - tab.lastUsedAt > RESEARCH_TAB_TTL_MS;
    if (!relayChanged && !stale) {
      continue;
    }

    if (activeRelay && tab.relayBaseUrl === activeRelay.baseUrl) {
      await closeRelayTab(activeRelay, tab.tabId);
    }
    researchTabs.delete(sessionId);
  }
}

async function ensureResearchTab(sessionId: string, relay: BrowserRelayCapability) {
  const existing = researchTabs.get(sessionId);
  if (existing && existing.relayBaseUrl === relay.baseUrl) {
    existing.lastUsedAt = Date.now();
    return existing.tabId;
  }

  const tabId = await openRelayTab(relay);
  researchTabs.set(sessionId, {
    tabId,
    relayBaseUrl: relay.baseUrl,
    lastUsedAt: Date.now(),
  });
  return tabId;
}

function clearResearchTab(sessionId: string, tabId?: string | null) {
  const existing = researchTabs.get(sessionId);
  if (!existing) {
    return;
  }

  if (tabId && existing.tabId !== tabId) {
    return;
  }

  researchTabs.delete(sessionId);
}

export async function withDesktopRelayTab<T>(
  sessionId: string,
  callback: (
    relay: BrowserRelayCapability,
    tabId: string,
  ) => Promise<T>,
): Promise<T | null> {
  const relay = getHealthyBrowserRelayCapability();
  if (!relay) {
    return null;
  }

  await closeStaleResearchTabs(relay);
  let tabId = await ensureResearchTab(sessionId, relay);

  try {
    const result = await callback(relay, tabId);
    const existing = researchTabs.get(sessionId);
    if (existing && existing.tabId === tabId) {
      existing.lastUsedAt = Date.now();
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = /Unknown browser relay tab/i.test(message);
    clearResearchTab(sessionId, tabId);
    if (!shouldRetry) {
      throw error;
    }

    tabId = await ensureResearchTab(sessionId, relay);
    const result = await callback(relay, tabId);
    const existing = researchTabs.get(sessionId);
    if (existing && existing.tabId === tabId) {
      existing.lastUsedAt = Date.now();
    }
    return result;
  }
}

export async function navigateRelayTab(
  relay: BrowserRelayCapability,
  tabId: string,
  url: string,
  waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded",
) {
  return requestRelay(relay, `/tabs/${encodeURIComponent(tabId)}/navigate`, {
    method: "POST",
    body: JSON.stringify({
      url,
      waitUntil,
    }),
  });
}

export async function readRelayReadableContent(
  relay: BrowserRelayCapability,
  tabId: string,
  options?: {
    maxTextLength?: number;
    extractMain?: boolean;
  },
) {
  const searchParams = new URLSearchParams();
  if (typeof options?.maxTextLength === "number") {
    searchParams.set("maxTextLength", String(options.maxTextLength));
  }
  if (typeof options?.extractMain === "boolean") {
    searchParams.set("extractMain", String(options.extractMain));
  }

  const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  return requestRelay<DesktopRelayReadablePayload>(
    relay,
    `/tabs/${encodeURIComponent(tabId)}/readable${suffix}`,
    { method: "GET" },
  );
}

export async function readRelaySearchResults(
  relay: BrowserRelayCapability,
  tabId: string,
  maxResults: number,
) {
  const searchParams = new URLSearchParams({
    maxResults: String(maxResults),
  });
  return requestRelay<DesktopRelaySearchPayload>(
    relay,
    `/tabs/${encodeURIComponent(tabId)}/search-results?${searchParams.toString()}`,
    { method: "GET" },
  );
}

export function hasHealthyDesktopRelay() {
  return hasHealthyDaemonChromeRelay();
}

export async function disposeDesktopRelayResearchTabs() {
  const relay = getHealthyBrowserRelayCapability();
  if (relay) {
    await closeStaleResearchTabs(null);
    return;
  }

  researchTabs.clear();
}
