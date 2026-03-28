import type {
  BrowserAudioCapturePayload,
  BrowserBackend,
  BrowserEvalPayload,
  BrowserMediaProbePayload,
  BrowserReadablePayload,
  BrowserRelayTabsPayload,
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

export async function requestDesktopRelay<T>(
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

export async function ensureDesktopRelayTab(session: BrowserSessionRecord) {
  if (session.tabId) {
    return session.tabId;
  }

  const opened = await requestDesktopRelay<{ tabId?: unknown }>(session, "/tabs/open", {
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
    const tabId = await ensureDesktopRelayTab(session);
    const snapshot = await requestDesktopRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/navigate`, {
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
    const tabId = await ensureDesktopRelayTab(session);
    const searchParams = new URLSearchParams();
    if (typeof options?.maxTextLength === "number") {
      searchParams.set("maxTextLength", String(options.maxTextLength));
    }
    if (typeof options?.maxElements === "number") {
      searchParams.set("maxElements", String(options.maxElements));
    }
    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
    const snapshot = await requestDesktopRelay<BrowserSnapshotPayload>(
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
    const tabId = await ensureDesktopRelayTab(session);
    const snapshot = await requestDesktopRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/click`, {
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
    const tabId = await ensureDesktopRelayTab(session);
    const snapshot = await requestDesktopRelay<BrowserSnapshotPayload>(session, `/tabs/${encodeURIComponent(tabId)}/type`, {
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

  async screenshot(session, outputPath, fullPage, ref) {
    const tabId = await ensureDesktopRelayTab(session);
    const result = await requestDesktopRelay<BrowserScreenshotPayload>(
      session,
      `/tabs/${encodeURIComponent(tabId)}/screenshot`,
      {
        method: "POST",
        body: JSON.stringify({
          outputPath,
          fullPage,
          ref,
        }),
      },
    );
    session.tabId = result.tabId ?? tabId;
    return result;
  },

  async mediaProbe(session, ref) {
    const tabId = await ensureDesktopRelayTab(session);
    const searchParams = new URLSearchParams();
    if (ref?.trim()) {
      searchParams.set("ref", ref.trim());
    }
    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
    const result = await requestDesktopRelay<BrowserMediaProbePayload>(
      session,
      `/tabs/${encodeURIComponent(tabId)}/media-probe${suffix}`,
      {
        method: "GET",
      },
    );
    session.tabId = result.tabId ?? tabId;
    return result;
  },

  async captureAudioClip(session, options) {
    const tabId = await ensureDesktopRelayTab(session);
    const result = await requestDesktopRelay<BrowserAudioCapturePayload>(
      session,
      `/tabs/${encodeURIComponent(tabId)}/capture-audio`,
      {
        method: "POST",
        body: JSON.stringify({
          outputPath: options?.outputPath,
          ref: options?.ref,
          clipMs: options?.clipMs,
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
      await requestDesktopRelay<{ ok?: boolean }>(session, `/tabs/${encodeURIComponent(session.tabId)}`, {
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

export async function listDesktopRelayTabs(session: BrowserSessionRecord) {
  return requestDesktopRelay<BrowserRelayTabsPayload>(session, "/tabs", {
    method: "GET",
  });
}

export async function readDesktopRelay(session: BrowserSessionRecord, tabId: string, options?: {
  maxTextLength?: number;
  extractMain?: boolean;
}) {
  const searchParams = new URLSearchParams();
  if (typeof options?.maxTextLength === "number") {
    searchParams.set("maxTextLength", String(options.maxTextLength));
  }
  if (typeof options?.extractMain === "boolean") {
    searchParams.set("extractMain", String(options.extractMain));
  }
  const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  return requestDesktopRelay<BrowserReadablePayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/readable${suffix}`,
    { method: "GET" },
  );
}

export async function readDesktopRelayDom(session: BrowserSessionRecord, tabId: string, options?: {
  maxTextLength?: number;
  maxElements?: number;
}) {
  const searchParams = new URLSearchParams();
  if (typeof options?.maxTextLength === "number") {
    searchParams.set("maxTextLength", String(options.maxTextLength));
  }
  if (typeof options?.maxElements === "number") {
    searchParams.set("maxElements", String(options.maxElements));
  }
  const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  return requestDesktopRelay<BrowserSnapshotPayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/read-dom${suffix}`,
    { method: "GET" },
  );
}

export async function scrollDesktopRelay(session: BrowserSessionRecord, tabId: string, direction: "up" | "down" | "left" | "right", amount?: number) {
  return requestDesktopRelay<BrowserSnapshotPayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/scroll`,
    {
      method: "POST",
      body: JSON.stringify({
        direction,
        amount,
      }),
    },
  );
}

export async function evalDesktopRelay(session: BrowserSessionRecord, tabId: string, expression: string) {
  return requestDesktopRelay<BrowserEvalPayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/eval`,
    {
      method: "POST",
      body: JSON.stringify({
        expression,
      }),
    },
  );
}

export async function backDesktopRelay(session: BrowserSessionRecord, tabId: string, waitUntil?: BrowserWaitUntil) {
  return requestDesktopRelay<BrowserSnapshotPayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/back`,
    {
      method: "POST",
      body: JSON.stringify({
        waitUntil,
      }),
    },
  );
}

export async function forwardDesktopRelay(session: BrowserSessionRecord, tabId: string, waitUntil?: BrowserWaitUntil) {
  return requestDesktopRelay<BrowserSnapshotPayload>(
    session,
    `/tabs/${encodeURIComponent(tabId)}/forward`,
    {
      method: "POST",
      body: JSON.stringify({
        waitUntil,
      }),
    },
  );
}
