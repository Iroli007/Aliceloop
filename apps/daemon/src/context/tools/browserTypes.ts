import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { getDataDir } from "../../db/client";

export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";
export type BrowserBackendKind = "desktop_chrome" | "playwright";

export interface BrowserSnapshotPayload {
  url: string;
  title: string;
  headings: Array<{ level: string; text: string }>;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type: string;
    name: string;
    placeholder: string;
    href: string;
    value: string;
    disabled: boolean;
  }>;
  pageText: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserScreenshotPayload {
  path: string;
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserSessionRecord {
  sessionId: string;
  backend: BrowserBackendKind | null;
  tabId: string | null;
  relayBaseUrl: string | null;
  relayToken: string | null;
}

export interface BrowserBackend {
  kind: BrowserBackendKind;
  navigate(session: BrowserSessionRecord, url: string, waitUntil: BrowserWaitUntil): Promise<BrowserSnapshotPayload>;
  snapshot(
    session: BrowserSessionRecord,
    options?: {
      maxTextLength?: number;
      maxElements?: number;
    },
  ): Promise<BrowserSnapshotPayload>;
  click(session: BrowserSessionRecord, ref: string, waitUntil: BrowserWaitUntil): Promise<BrowserSnapshotPayload>;
  type(session: BrowserSessionRecord, ref: string, text: string, submit: boolean): Promise<BrowserSnapshotPayload>;
  screenshot(session: BrowserSessionRecord, outputPath?: string, fullPage?: boolean): Promise<BrowserScreenshotPayload>;
  disposeSession(session: BrowserSessionRecord): Promise<void>;
}

const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;

let screenshotSequence = 0;

export function resolveDefaultScreenshotPath() {
  screenshotSequence += 1;
  return join(
    getDataDir(),
    "browser-screenshots",
    `aliceloop-browser-${Date.now()}-${screenshotSequence}.png`,
  );
}

export function normalizeWaitUntil(value: string | undefined): BrowserWaitUntil {
  if (value === "load" || value === "networkidle") {
    return value;
  }

  return "domcontentloaded";
}

export function escapeAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function friendlyBrowserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Executable doesn't exist")) {
    return `${message}\nRun \`npx playwright install chromium\` to provision the local browser runtime.`;
  }

  return message;
}

export async function collectSnapshot(
  page: Page,
  backend: BrowserBackendKind,
  tabId: string,
  options?: {
    maxTextLength?: number;
    maxElements?: number;
  },
): Promise<BrowserSnapshotPayload> {
  type SnapshotCore = Omit<BrowserSnapshotPayload, "backend" | "tabId">;
  const payload = JSON.stringify({
    maxTextLength: options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    maxElements: options?.maxElements ?? DEFAULT_MAX_ELEMENTS,
  });

  const result = await page.evaluate(`
    (() => {
      const input = ${payload};
      const counterKey = "__ALICELOOP_BROWSER_REF_COUNTER__";
      const scope = globalThis;
      let nextRef = Number.isFinite(scope[counterKey]) ? Number(scope[counterKey]) : 1;

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function ensureRef(element) {
        const existing = element.getAttribute("data-aliceloop-ref");
        if (existing) {
          return existing;
        }

        const next = "e" + nextRef;
        nextRef += 1;
        element.setAttribute("data-aliceloop-ref", next);
        return next;
      }

      const interactiveSelector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='link']",
        "[contenteditable='true']"
      ].join(",");

      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(isVisible)
        .slice(0, 12)
        .map(function (element) {
          return {
            level: element.tagName.toLowerCase(),
            text: compact(element.textContent, 160)
          };
        })
        .filter(function (entry) {
          return entry.text.length > 0;
        });

      const elements = Array.from(document.querySelectorAll(interactiveSelector))
        .filter(isVisible)
        .slice(0, input.maxElements)
        .map(function (element) {
          const htmlElement = element;
          const ref = ensureRef(element);
          const text = compact(
            htmlElement.innerText || htmlElement.textContent || htmlElement.getAttribute("aria-label"),
            160
          );
          const href = element.tagName === "A" ? element.href : compact(element.getAttribute("href"), 240);
          const rawValue = Array.isArray(htmlElement.value)
            ? htmlElement.value.join(", ")
            : (typeof htmlElement.value === "string" ? htmlElement.value : String(htmlElement.value ?? ""));

          return {
            ref,
            tag: element.tagName.toLowerCase(),
            role: compact(element.getAttribute("role"), 40),
            text,
            type: compact(htmlElement.type, 40),
            name: compact(htmlElement.name, 60),
            placeholder: compact(htmlElement.placeholder, 80),
            href,
            value: compact(rawValue, 120),
            disabled: Boolean(htmlElement.disabled) || element.getAttribute("aria-disabled") === "true"
          };
        });

      scope[counterKey] = nextRef;

      return {
        url: window.location.href,
        title: compact(document.title, 200),
        headings,
        elements,
        pageText: compact(document.body ? document.body.innerText : "", input.maxTextLength)
      };
    })()
  `) as SnapshotCore;

  return {
    ...result,
    backend,
    tabId,
  };
}

export function ensureDirectoryForFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}
