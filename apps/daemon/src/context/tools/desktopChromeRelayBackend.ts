import type {
  BrowserBackend,
  BrowserScreenshotPayload,
  BrowserSnapshotPayload,
  BrowserSessionRecord,
  BrowserWaitUntil,
} from "./browserTypes";

type JsonRecord = Record<string, unknown>;

type RelayErrorPayload = {
  error?: unknown;
  detail?: unknown;
};

export class DesktopBrowserUnavailableError extends Error {
  readonly code = "desktop_browser_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "DesktopBrowserUnavailableError";
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceRelayDetail(payload: unknown, fallback: string) {
  if (!isJsonRecord(payload)) {
    return fallback;
  }

  const detail = typeof payload.detail === "string" ? payload.detail : null;
  const error = typeof payload.error === "string" ? payload.error : null;
  return detail ?? error ?? fallback;
}

async function requestRelay<T>(
  session: BrowserSessionRecord,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!session.relayBaseUrl || !session.relayToken) {
    throw new DesktopBrowserUnavailableError("No healthy Aliceloop Desktop Chrome relay is registered.");
  }

  let response: Response;
  try {
    response = await fetch(`${session.relayBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.relayToken}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new DesktopBrowserUnavailableError(
      error instanceof Error
        ? `Failed to reach Aliceloop Desktop Chrome relay: ${error.message}`
        : "Failed to reach Aliceloop Desktop Chrome relay.",
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    throw new DesktopBrowserUnavailableError("Desktop Chrome relay rejected authentication.");
  }

  if (!response.ok) {
    throw new Error(coerceRelayDetail(payload, `Desktop Chrome relay request failed (${response.status})`));
  }

  return payload as T;
}

async function ensureDesktopTab(session: BrowserSessionRecord) {
  if (session.tabId) {
    return session.tabId;
  }

  const opened = await requestRelay<{ tabId?: unknown }>(session, "/tabs/open", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const tabId = typeof opened.tabId === "string" ? opened.tabId : null;
  if (!tabId) {
    throw new Error("Desktop Chrome relay did not return a tab id.");
  }

  session.tabId = tabId;
  return tabId;
}

export function isDesktopBrowserUnavailableError(error: unknown): error is DesktopBrowserUnavailableError {
  return error instanceof DesktopBrowserUnavailableError;
}

export const desktopChromeRelayBackend: BrowserBackend = {
  kind: "desktop_chrome",

  async navigate(session, url, waitUntil) {
    const tabId = await ensureDesktopTab(session);
    const snapshot = await requestRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: "POST",
      body: JSON.stringify({
        url,
        waitUntil,
      }),
    });
    session.tabId = snapshot.tabId ?? tabId;
    return snapshot;
  },

  async snapshot(session, options) {
    const tabId = await ensureDesktopTab(session);
    const searchParams = new URLSearchParams();
    if (typeof options?.maxTextLength === "number") {
      searchParams.set("maxTextLength", String(options.maxTextLength));
    }
    if (typeof options?.maxElements === "number") {
      searchParams.set("maxElements", String(options.maxElements));
    }
    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
    const snapshot = await requestRelay<BrowserSnapshotPayload>(
      session,
      `/tabs/${encodeURIComponent(tabId)}/snapshot${suffix}`,
      {
        method: "GET",
      },
    );
    session.tabId = snapshot.tabId ?? tabId;
    return snapshot;
  },

  async click(session, ref, waitUntil) {
    const tabId = await ensureDesktopTab(session);
    const snapshot = await requestRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/click`, {
      method: "POST",
      body: JSON.stringify({
        ref,
        waitUntil,
      }),
    });
    session.tabId = snapshot.tabId ?? tabId;
    return snapshot;
  },

  async type(session, ref, text, submit) {
    const tabId = await ensureDesktopTab(session);
    const snapshot = await requestRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/type`, {
      method: "POST",
      body: JSON.stringify({
        ref,
        text,
        submit,
      }),
    });
    session.tabId = snapshot.tabId ?? tabId;
    return snapshot;
  },

  async screenshot(session, outputPath, fullPage) {
    const tabId = await ensureDesktopTab(session);
    const result = await requestRelay<BrowserScreenshotPayload>(
      session,
      `/tabs/${encodeURIComponent(tabId)}/screenshot`,
      {
        method: "POST",
        body: JSON.stringify({
          outputPath,
          fullPage,
        }),
      },
    );
    session.tabId = result.tabId ?? tabId;
    return result;
  },

  async disposeSession(session) {
    if (!session.tabId) {
      session.backend = null;
      session.relayBaseUrl = null;
      session.relayToken = null;
      return;
    }

    try {
      await requestRelay<{ ok?: boolean }>(session, `/tabs/${encodeURIComponent(session.tabId)}`, {
        method: "DELETE",
      });
    } catch {
      // Best-effort tab cleanup only.
    }

    session.tabId = null;
    session.backend = null;
    session.relayBaseUrl = null;
    session.relayToken = null;
  },
};
