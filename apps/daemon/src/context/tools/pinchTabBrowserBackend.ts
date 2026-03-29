import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  type BrowserAudioCapturePayload,
  type BrowserBackend,
  buildBrowserSnapshotPayload,
  type BrowserMediaProbePayload,
  resolveDefaultScreenshotPath,
  type BrowserSessionRecord,
  type BrowserSnapshotPayload,
  type BrowserWaitUntil,
} from "./browserTypes";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;
const PINCHTAB_BINARY = "pinchtab";

type PinchTabTextPayload = {
  text?: unknown;
  title?: unknown;
  url?: unknown;
  truncated?: unknown;
};

type PinchTabSnapPayload = {
  count?: unknown;
  nodes?: Array<{
    ref?: unknown;
    role?: unknown;
    name?: unknown;
    depth?: unknown;
    nodeId?: unknown;
  }>;
};

type PinchTabTabsPayload = {
  tabs?: Array<{
    id?: unknown;
    title?: unknown;
    url?: unknown;
    type?: unknown;
  }>;
};

type PinchTabResultPayload = {
  success?: unknown;
  result?: Record<string, unknown>;
};

export class PinchTabUnavailableError extends Error {
  readonly code = "pinchtab_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PinchTabUnavailableError";
  }
}

function normalizeCliOutput(stdout: string, stderr: string) {
  const output = [stdout, stderr].map((value) => value.trim()).filter(Boolean).join("\n").trim();
  const errorMatch = output.match(/^Error\s+\d+:\s+(.+)$/m);
  if (errorMatch?.[1]) {
    throw new Error(errorMatch[1]);
  }

  return output;
}

async function runPinchTab(args: string[]) {
  try {
    const { stdout, stderr } = await execFile(PINCHTAB_BINARY, args, {
      maxBuffer: 1024 * 1024 * 8,
      encoding: "utf8",
    });
    return normalizeCliOutput(stdout, stderr);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new PinchTabUnavailableError("PinchTab is not installed or not available in PATH.");
    }

    if (error instanceof Error) {
      const maybeStdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const maybeStderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      const output = [maybeStdout, maybeStderr, error.message].filter(Boolean).join("\n").trim();
      if (/connect|refused|unavailable|daemon|server/i.test(output)) {
        throw new PinchTabUnavailableError(output);
      }
      throw new Error(output || "PinchTab command failed.");
    }

    throw error;
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`PinchTab ${label} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasPinchTabBinary() {
  const result = spawnSync(PINCHTAB_BINARY, ["--help"], {
    stdio: "ignore",
  });
  return !result.error;
}

function normalizeTextPayload(payload: PinchTabTextPayload) {
  return {
    url: typeof payload.url === "string" ? payload.url : "about:blank",
    title: typeof payload.title === "string" ? payload.title : "",
    pageText: typeof payload.text === "string" ? payload.text : "",
  };
}

function normalizeElements(payload: PinchTabSnapPayload, maxElements?: number) {
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  return nodes.slice(0, maxElements ?? DEFAULT_MAX_ELEMENTS).map((node) => {
    const role = typeof node.role === "string" ? node.role : "";
    const name = typeof node.name === "string" ? node.name : "";
    const ref = typeof node.ref === "string" ? node.ref : "";
    return {
      ref,
      tag: role || "unknown",
      role,
      text: name,
      type: "",
      name,
      placeholder: "",
      href: "",
      value: "",
      disabled: false,
    };
  }).filter((node) => node.ref);
}

async function listPinchTabTabs() {
  const output = await runPinchTab(["tab"]);
  const parsed = parseJson<PinchTabTabsPayload>(output, "tab");
  const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  return tabs.map((tab) => ({
    id: typeof tab.id === "string" ? tab.id : "",
    title: typeof tab.title === "string" ? tab.title : null,
    url: typeof tab.url === "string" ? tab.url : "about:blank",
    type: typeof tab.type === "string" ? tab.type : "page",
  })).filter((tab) => tab.id);
}

async function resolveTabId(session: BrowserSessionRecord) {
  if (session.tabId) {
    return session.tabId;
  }

  const tabs = await listPinchTabTabs();
  const current = tabs[0]?.id ?? null;
  if (!current) {
    throw new PinchTabUnavailableError("PinchTab has no available tabs. Open a page first or start the PinchTab browser service.");
  }

  session.tabId = current;
  return current;
}

async function collectPinchTabSnapshot(
  session: BrowserSessionRecord,
  options?: {
    maxTextLength?: number;
    maxElements?: number;
  },
): Promise<BrowserSnapshotPayload> {
  const tabId = await resolveTabId(session);
  const [textOutput, snapOutput] = await Promise.all([
    runPinchTab(["text", "--tab", tabId]),
    runPinchTab(["snap", "-i", "--tab", tabId]),
  ]);
  const textPayload = normalizeTextPayload(parseJson<PinchTabTextPayload>(textOutput, "text"));
  const snapPayload = parseJson<PinchTabSnapPayload>(snapOutput, "snap");
  const pageText = textPayload.pageText.slice(0, options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH);
  const elements = normalizeElements(snapPayload, options?.maxElements);

  return buildBrowserSnapshotPayload({
    url: textPayload.url,
    title: textPayload.title,
    headings: [],
    elements,
    pageText,
  }, "pinchtab", tabId);
}

async function navigateWithPinchTab(session: BrowserSessionRecord, url: string) {
  if (session.tabId) {
    await runPinchTab(["nav", url, "--tab", session.tabId]);
    return session.tabId;
  }

  const before = await listPinchTabTabs();
  await runPinchTab(["nav", url, "--new-tab"]);
  const after = await listPinchTabTabs();
  const beforeIds = new Set(before.map((tab) => tab.id));
  const newTab = after.find((tab) => !beforeIds.has(tab.id))
    ?? after.find((tab) => tab.url === url)
    ?? after[0];

  if (!newTab?.id) {
    throw new Error("PinchTab navigation succeeded but no browser tab could be resolved.");
  }

  session.tabId = newTab.id;
  return newTab.id;
}

function ensureSuccessfulAction(raw: string, label: string) {
  const parsed = parseJson<PinchTabResultPayload>(raw, label);
  if (parsed.success === false) {
    throw new Error(`PinchTab ${label} failed.`);
  }
}

export function isPinchTabUnavailableError(error: unknown): error is PinchTabUnavailableError {
  return error instanceof PinchTabUnavailableError;
}

export const pinchTabBrowserBackend: BrowserBackend = {
  kind: "pinchtab",

  async navigate(session, url, _waitUntil) {
    await navigateWithPinchTab(session, url);
    return collectPinchTabSnapshot(session);
  },

  async snapshot(session, options) {
    return collectPinchTabSnapshot(session, options);
  },

  async click(session, ref, _waitUntil) {
    const tabId = await resolveTabId(session);
    ensureSuccessfulAction(await runPinchTab(["click", ref, "--tab", tabId, "--wait-nav"]), "click");
    return collectPinchTabSnapshot(session);
  },

  async type(session, ref, text, submit) {
    const tabId = await resolveTabId(session);
    ensureSuccessfulAction(await runPinchTab(["fill", ref, text, "--tab", tabId]), "fill");
    if (submit) {
      ensureSuccessfulAction(await runPinchTab(["press", "Enter", "--tab", tabId]), "press");
    }
    return collectPinchTabSnapshot(session);
  },

  async scroll(session, direction, amount) {
    const tabId = await resolveTabId(session);
    const stepCount = Math.max(1, Math.min(6, Math.round((amount ?? 800) / 700)));
    const keyByDirection = {
      up: "PageUp",
      down: "PageDown",
      left: "ArrowLeft",
      right: "ArrowRight",
    } as const;

    for (let index = 0; index < stepCount; index += 1) {
      ensureSuccessfulAction(await runPinchTab(["press", keyByDirection[direction], "--tab", tabId]), "press");
    }

    return collectPinchTabSnapshot(session);
  },

  async screenshot(session, outputPath, _fullPage, ref) {
    if (ref?.trim()) {
      throw new Error("PinchTab screenshot currently supports full-page capture only; element ref capture is unavailable.");
    }

    const tabId = await resolveTabId(session);
    const targetPath = outputPath?.trim() || resolveDefaultScreenshotPath().replace(/\.png$/i, ".jpg");
    await runPinchTab(["screenshot", "--tab", tabId, "--output", targetPath]);
    const textOutput = await runPinchTab(["text", "--tab", tabId]);
    const textPayload = normalizeTextPayload(parseJson<PinchTabTextPayload>(textOutput, "text"));

    return {
      path: targetPath,
      url: textPayload.url,
      backend: "pinchtab" as const,
      tabId,
    };
  },

  async mediaProbe(session, _ref) {
    const tabId = await resolveTabId(session);
    const textOutput = await runPinchTab(["text", "--tab", tabId]);
    const textPayload = normalizeTextPayload(parseJson<PinchTabTextPayload>(textOutput, "text"));
    return {
      url: textPayload.url,
      title: textPayload.title,
      backend: "pinchtab",
      tabId,
      playerRef: null,
      subtitleSource: "none",
      subtitles: [],
      candidates: [],
    } satisfies BrowserMediaProbePayload;
  },

  async captureAudioClip(session, options) {
    const tabId = await resolveTabId(session);
    const textOutput = await runPinchTab(["text", "--tab", tabId]);
    const textPayload = normalizeTextPayload(parseJson<PinchTabTextPayload>(textOutput, "text"));
    return {
      path: null,
      mediaType: null,
      url: textPayload.url,
      backend: "pinchtab",
      tabId,
      ref: options?.ref?.trim() || null,
      currentTime: null,
      durationMs: Math.max(2_000, Math.min(12_000, options?.clipMs ?? 10_000)),
      limitation: "PinchTab audio capture is not wired into Aliceloop yet. Use Chrome Relay for browser audio capture.",
    } satisfies BrowserAudioCapturePayload;
  },

  async disposeSession(session) {
    session.tabId = null;
    session.backend = null;
    session.relayBaseUrl = null;
  },
};

export function pinchTabAvailable() {
  return hasPinchTabBinary();
}
