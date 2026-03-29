import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import type {
  BrowserReadablePayload,
  BrowserAudioCapturePayload,
  BrowserEvalPayload,
  BrowserMediaProbePayload,
  BrowserRelayTabsPayload,
  BrowserScreenshotPayload,
  BrowserSearchResultsPayload,
  BrowserSnapshotPayload,
  BrowserWaitUntil,
  ChromeRelayMeta,
} from "./chromeRelayTypes";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_SCREENSHOT_ROOT_NAME = "browser-screenshots";
const DEFAULT_AUDIO_CAPTURE_ROOT_NAME = "browser-watch-audio";

function escapeAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveRefLocator(page: Page, ref: string) {
  const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
  for (const frame of page.frames()) {
    const locator = frame.locator(selector).first();
    if ((await locator.count()) > 0) {
      return locator;
    }
  }

  return null;
}

function normalizeWaitUntil(value: string | undefined): BrowserWaitUntil {
  if (value === "load" || value === "networkidle") {
    return value;
  }

  return "domcontentloaded";
}

async function collectSnapshot(
  page: Page,
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

      function getFrameElementForWindow(view) {
        try {
          return view && view.frameElement instanceof Element ? view.frameElement : null;
        } catch {
          return null;
        }
      }

      function isVisible(element) {
        let currentElement = element;
        while (currentElement) {
          const view = currentElement.ownerDocument?.defaultView || window;
          const style = view.getComputedStyle(currentElement);
          const rect = currentElement.getBoundingClientRect();
          if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) {
            return false;
          }

          const frameElement = getFrameElementForWindow(view);
          if (!frameElement) {
            return true;
          }

          currentElement = frameElement;
        }

        return true;
      }

      function collectAccessibleRoots() {
        const roots = [];
        const seenRoots = new Set();
        const seenDocuments = new Set();

        function visit(root) {
          if (!root || seenRoots.has(root)) {
            return;
          }

          seenRoots.add(root);
          roots.push(root);

          const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
          for (const element of descendants) {
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }

            if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
              try {
                const nestedDocument = element.contentDocument;
                if (nestedDocument && !seenDocuments.has(nestedDocument)) {
                  seenDocuments.add(nestedDocument);
                  visit(nestedDocument);
                }
              } catch {
                // Cross-origin frame; ignore it.
              }
            }
          }
        }

        seenDocuments.add(document);
        visit(document);
        return roots;
      }

      function queryAllAcrossRoots(selector) {
        const results = [];
        const seenElements = new Set();
        for (const root of collectAccessibleRoots()) {
          let matches = [];
          try {
            matches = Array.from(root.querySelectorAll(selector));
          } catch {
            matches = [];
          }

          for (const element of matches) {
            if (seenElements.has(element)) {
              continue;
            }

            seenElements.add(element);
            results.push(element);
          }
        }

        return results;
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
        "[contenteditable='true']",
        "video",
        "audio",
        "img",
        "canvas",
        "svg",
        "[role='img']"
      ].join(",");

      const roots = collectAccessibleRoots();

      const headings = queryAllAcrossRoots("h1,h2,h3")
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

      const elements = queryAllAcrossRoots(interactiveSelector)
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
        pageText: compact(roots.map(function (root) {
          if (root.nodeType === Node.DOCUMENT_NODE) {
            return root.body ? root.body.innerText : "";
          }

          return root.textContent || "";
        }).join("\\n"), input.maxTextLength)
      };
    })()
  `) as SnapshotCore;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function collectReadableContent(
  page: Page,
  tabId: string,
  options?: {
    maxTextLength?: number;
    extractMain?: boolean;
  },
): Promise<BrowserReadablePayload> {
  const payload = JSON.stringify({
    maxTextLength: options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    extractMain: options?.extractMain !== false,
  });

  const result = await page.evaluate(`
    (() => {
      const input = ${payload};

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function getMetaContent(selector) {
        const element = document.querySelector(selector);
        const content = element?.getAttribute("content");
        return content ? compact(content, 120) : null;
      }

      const publishedAt =
        getMetaContent('meta[property="article:published_time"]') ||
        getMetaContent('meta[name="pubdate"]') ||
        getMetaContent('meta[name="publishdate"]') ||
        document.querySelector('time[datetime]')?.getAttribute('datetime') ||
        null;

      const modifiedAt =
        getMetaContent('meta[property="article:modified_time"]') ||
        getMetaContent('meta[name="lastmod"]') ||
        null;

      const root = input.extractMain
        ? document.querySelector("main, article") || document.body
        : document.body;

      const pageText = compact(root ? root.innerText : document.body?.innerText ?? "", input.maxTextLength);

      return {
        url: window.location.href,
        title: compact(document.title, 200),
        publishedAt: publishedAt ? compact(publishedAt, 120) : null,
        modifiedAt: modifiedAt ? compact(modifiedAt, 120) : null,
        pageText,
      };
    })()
  `) as Omit<BrowserReadablePayload, "backend" | "tabId">;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function collectSearchResults(
  page: Page,
  tabId: string,
  maxResults: number,
): Promise<BrowserSearchResultsPayload> {
  const payload = JSON.stringify({
    maxResults,
  });

  const result = await page.evaluate(`
    (() => {
      const input = ${payload};

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function extractDomain(url) {
        try {
          return new URL(url, window.location.href).hostname.toLowerCase();
        } catch {
          return "";
        }
      }

      const results = [];
      const seen = new Set();

      function pushResult(title, url, snippet) {
        const normalizedTitle = compact(title, 180);
        const normalizedUrl = compact(url, 400);
        if (!normalizedTitle || !normalizedUrl || seen.has(normalizedUrl)) {
          return;
        }

        seen.add(normalizedUrl);
        results.push({
          title: normalizedTitle,
          url: normalizedUrl,
          snippet: compact(snippet, 280),
          domain: extractDomain(normalizedUrl),
        });
      }

      const structuredNodes = Array.from(document.querySelectorAll(".result, [data-testid='result'], article"))
        .filter(isVisible);

      for (const node of structuredNodes) {
        if (results.length >= input.maxResults) {
          break;
        }

        const link = node.querySelector("a.result__a, h2 a, h3 a, a[href]");
        if (!link || !isVisible(link)) {
          continue;
        }

        const snippetNode =
          node.querySelector(".result__snippet, .snippet, [class*='snippet'], p") ||
          node.querySelector("div");

        pushResult(
          link.textContent || link.getAttribute("aria-label") || "",
          link.href || link.getAttribute("href") || "",
          snippetNode?.textContent || "",
        );
      }

      if (results.length < input.maxResults) {
        const genericLinks = Array.from(document.querySelectorAll("main a[href], article a[href], body a[href]"))
          .filter((link) => isVisible(link));

        for (const link of genericLinks) {
          if (results.length >= input.maxResults) {
            break;
          }

          const text = compact(link.textContent || link.getAttribute("aria-label") || "", 180);
          const href = link.href || link.getAttribute("href") || "";
          if (text.length < 4) {
            continue;
          }

          pushResult(text, href, link.closest("article, section, div")?.textContent || "");
        }
      }

      return {
        url: window.location.href,
        results: results.slice(0, input.maxResults),
      };
    })()
  `) as Omit<BrowserSearchResultsPayload, "backend" | "tabId">;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

function sanitizeEvalResult(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvalResult(entry));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  return String(value);
}

type PageAudioCaptureResult = {
  ok: boolean;
  ref: string | null;
  mediaType: string | null;
  currentTime: number | null;
  dataBase64?: string;
  limitation?: string;
};

function ensureDirectoryForFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

async function collectMediaProbe(
  page: Page,
  tabId: string,
  ref?: string,
): Promise<BrowserMediaProbePayload> {
  const payload = JSON.stringify({ ref: ref ?? null });
  const result = await page.evaluate(`
    (() => {
      const { ref: requestedRef } = ${payload};
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

      function uniqueTexts(values) {
        const normalized = values
          .map(function (value) {
            return compact(value, 200);
          })
          .filter(function (value) {
            return value.length > 0;
          });
        return Array.from(new Set(normalized)).slice(0, 8);
      }

      function collectTrackCaptions(media) {
        const captions = [];
        const tracks = Array.from(media.textTracks ?? []);
        for (const track of tracks) {
          const cues = Array.from(track.activeCues ?? []);
          for (const cue of cues) {
            const text = "text" in cue ? String(cue.text ?? "") : "";
            if (text.trim()) {
              captions.push(text);
            }
          }
        }

        return uniqueTexts(captions);
      }

      function collectDomCaptions() {
        const selectors = [
          "[class*='caption']",
          "[class*='Caption']",
          "[class*='subtitle']",
          "[class*='Subtitle']",
          "[class*='captions']",
          "[class*='subtitles']",
          "[data-testid*='caption']",
          "[data-testid*='subtitle']",
          "[aria-live='polite']",
          "[aria-live='assertive']"
        ];

        const texts = [];
        for (const node of Array.from(document.querySelectorAll(selectors.join(",")))) {
          if (!isVisible(node)) {
            continue;
          }

          const text = compact(node.textContent, 200);
          if (text.length >= 2) {
            texts.push(text);
          }
        }

        return uniqueTexts(texts);
      }

      const mediaElements = Array.from(document.querySelectorAll("video, audio"))
        .filter(isVisible)
        .map(function (element) {
          const media = element;
          const rect = media.getBoundingClientRect();
          const activeCaptions = collectTrackCaptions(media);
          return {
            element: media,
            ref: ensureRef(media),
            tag: media.tagName.toLowerCase(),
            label: compact(
              media.getAttribute("aria-label")
                || media.getAttribute("title")
                || media.closest("[aria-label],[title]")?.getAttribute("aria-label")
                || media.closest("[aria-label],[title]")?.getAttribute("title")
                || media.currentSrc
                || media.src,
              160
            ),
            area: Math.max(0, rect.width) * Math.max(0, rect.height),
            paused: media.paused,
            muted: media.muted || media.volume === 0,
            currentTime: Number.isFinite(media.currentTime) ? Number(media.currentTime) : null,
            duration: Number.isFinite(media.duration) ? Number(media.duration) : null,
            playbackRate: Number.isFinite(media.playbackRate) ? Number(media.playbackRate) : 1,
            textTrackCount: media.textTracks?.length ?? 0,
            activeCaptions,
            canCaptureAudio: typeof media.captureStream === "function"
          };
        })
        .sort(function (left, right) {
          return right.area - left.area;
        });

      const requestedElement = requestedRef
        ? document.querySelector('[data-aliceloop-ref="' + String(requestedRef).replace(/"/g, '\\"') + '"]')
        : null;
      const requestedCandidate = requestedElement
        ? mediaElements.find(function (candidate) {
            return candidate.element === requestedElement;
          })
        : null;
      const primaryCandidate = requestedCandidate ?? mediaElements[0] ?? null;
      const domCaptions = collectDomCaptions();
      const subtitles = primaryCandidate?.activeCaptions?.length
        ? primaryCandidate.activeCaptions
        : domCaptions;

      scope[counterKey] = nextRef;

      return {
        url: window.location.href,
        title: compact(document.title, 200),
        playerRef: primaryCandidate?.ref ?? null,
        subtitleSource: primaryCandidate?.activeCaptions?.length ? "textTracks" : (domCaptions.length ? "dom" : "none"),
        subtitles,
        candidates: mediaElements.map(function (candidate) {
          return {
            ref: candidate.ref,
            tag: candidate.tag,
            label: candidate.label,
            area: candidate.area,
            paused: candidate.paused,
            muted: candidate.muted,
            currentTime: candidate.currentTime,
            duration: candidate.duration,
            playbackRate: candidate.playbackRate,
            textTrackCount: candidate.textTrackCount,
            activeCaptions: candidate.activeCaptions,
            canCaptureAudio: candidate.canCaptureAudio
          };
        })
      };
    })()
  `) as Omit<BrowserMediaProbePayload, "backend" | "tabId">;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function captureMediaAudioClip(
  page: Page,
  tabId: string,
  options?: {
    outputPath?: string;
    ref?: string;
    clipMs?: number;
  },
): Promise<BrowserAudioCapturePayload> {
  const requestedClipMs = Math.max(2_000, Math.min(12_000, options?.clipMs ?? 10_000));
  const payload = JSON.stringify({ ref: options?.ref ?? null, clipMs: requestedClipMs });
  const captureResult = await page.evaluate(`
    (async () => {
      const { ref: requestedRef, clipMs } = ${payload};
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

      function findTargetMediaElement() {
        if (requestedRef) {
          const exact = document.querySelector('[data-aliceloop-ref="' + String(requestedRef).replace(/"/g, '\\"') + '"]');
          if (exact instanceof HTMLMediaElement) {
            return exact;
          }
        }

        return Array.from(document.querySelectorAll("video, audio"))
          .filter(function (element) {
            return element instanceof HTMLMediaElement;
          })
          .filter(isVisible)
          .sort(function (left, right) {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
          })[0] ?? null;
      }

      function toBase64(data) {
        let output = "";
        const chunkSize = 0x8000;
        for (let index = 0; index < data.length; index += chunkSize) {
          output += String.fromCharCode(...data.subarray(index, index + chunkSize));
        }

        return btoa(output);
      }

      const target = findTargetMediaElement();
      if (!target) {
        return {
          ok: false,
          ref: null,
          mediaType: null,
          currentTime: null,
          limitation: "No visible media element is available on the current page."
        };
      }

      const ref = ensureRef(target);
      if (typeof target.captureStream !== "function") {
        return {
          ok: false,
          ref,
          mediaType: null,
          currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
          limitation: "This media element does not expose captureStream()."
        };
      }

      if (target.paused) {
        return {
          ok: false,
          ref,
          mediaType: null,
          currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
          limitation: "The media element is paused, so there is no live audio to sample."
        };
      }

      try {
        const capturedStream = target.captureStream();
        const audioTracks = capturedStream.getAudioTracks();
        if (audioTracks.length === 0) {
          return {
            ok: false,
            ref,
            mediaType: null,
            currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
            limitation: "The media stream has no audio tracks."
          };
        }

        const audioStream = new MediaStream(audioTracks);
        const preferredMimeTypes = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus"
        ];
        const mimeType = preferredMimeTypes.find(function (value) {
          return MediaRecorder.isTypeSupported(value);
        }) ?? "";
        const recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
        const chunks = [];

        recorder.addEventListener("dataavailable", function (event) {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        });

        await new Promise(function (resolvePromise, rejectPromise) {
          recorder.addEventListener("error", function () {
            rejectPromise(new Error("MediaRecorder failed while capturing tab audio."));
          });
          recorder.addEventListener("stop", function () {
            resolvePromise();
          });
          recorder.start();
          setTimeout(function () {
            if (recorder.state !== "inactive") {
              recorder.stop();
            }
          }, clipMs);
        });

        audioStream.getTracks().forEach(function (track) {
          track.stop();
        });
        capturedStream.getTracks().forEach(function (track) {
          track.stop();
        });

        const blob = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm"
        });
        if (blob.size === 0) {
          return {
            ok: false,
            ref,
            mediaType: null,
            currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
            limitation: "The captured audio clip was empty."
          };
        }

        const buffer = new Uint8Array(await blob.arrayBuffer());
        scope[counterKey] = nextRef;
        return {
          ok: true,
          ref,
          mediaType: blob.type || recorder.mimeType || mimeType || "audio/webm",
          currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
          dataBase64: toBase64(buffer)
        };
      } catch (error) {
        return {
          ok: false,
          ref,
          mediaType: null,
          currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
          limitation: compact(error instanceof Error ? error.message : String(error), 240)
        };
      }
    })()
  `) as PageAudioCaptureResult;

  if (!captureResult.ok || !captureResult.dataBase64) {
    return {
      path: null,
      mediaType: captureResult.mediaType,
      url: page.url(),
      backend: "desktop_chrome",
      tabId,
      ref: captureResult.ref,
      currentTime: captureResult.currentTime,
      durationMs: requestedClipMs,
      limitation: captureResult.limitation ?? "The browser could not capture an audio clip.",
    };
  }

  const targetPath = options?.outputPath?.trim() || join(process.cwd(), DEFAULT_AUDIO_CAPTURE_ROOT_NAME, `browser-audio-${Date.now()}-${tabId}.webm`);
  ensureDirectoryForFile(targetPath);
  writeFileSync(targetPath, Buffer.from(captureResult.dataBase64, "base64"));

  return {
    path: targetPath,
    mediaType: captureResult.mediaType,
    url: page.url(),
    backend: "desktop_chrome",
    tabId,
    ref: captureResult.ref,
    currentTime: captureResult.currentTime,
    durationMs: requestedClipMs,
    limitation: null,
  };
}

async function readDevToolsPort(profileDir: string) {
  const portFile = join(profileDir, "DevToolsActivePort");
  if (!existsSync(portFile)) {
    return null;
  }

  const [portLine] = readFileSync(portFile, "utf8").split(/\r?\n/, 2);
  const port = Number(portLine?.trim());
  return Number.isFinite(port) && port > 0 ? port : null;
}

export interface ChromeRelayServiceOptions {
  chromeExecutablePath: string;
  profileDir: string;
  screenshotRoot: string;
  audioCaptureRoot: string;
  chromeExtensionDir: string | null;
}

type RelayTabRecord = {
  id: string;
  page: Page;
  history: string[];
  historyIndex: number;
  suppressNextHistoryEvent: boolean;
};

export class ChromeRelayService {
  private readonly chromeExecutablePath: string;

  private readonly profileDir: string;

  private readonly screenshotRoot: string;

  private readonly audioCaptureRoot: string;

  private readonly chromeExtensionDir: string | null;

  private chromeProcess: ChildProcess | null = null;

  private browser: Browser | null = null;

  private tabs = new Map<string, RelayTabRecord>();

  private connectionPromise: Promise<Browser> | null = null;

  private lastError: string | null = null;

  constructor(options: ChromeRelayServiceOptions) {
    this.chromeExecutablePath = options.chromeExecutablePath;
    this.profileDir = options.profileDir;
    this.screenshotRoot = options.screenshotRoot;
    this.audioCaptureRoot = options.audioCaptureRoot;
    this.chromeExtensionDir = options.chromeExtensionDir;
  }

  getCapability(baseUrl: string): ChromeRelayMeta {
    const enabled = existsSync(this.chromeExecutablePath);
    return {
      browserRelay: {
        enabled,
        backend: "desktop_chrome",
        baseUrl,
        visible: true,
        healthy: enabled && !this.lastError,
      },
    };
  }

  private markHealthy() {
    this.lastError = null;
  }

  private markError(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private async waitForBrowserReady(profileDir: string, chrome: ChildProcess) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < DEFAULT_CONNECT_TIMEOUT_MS) {
      if (chrome.exitCode !== null) {
        throw new Error(`Chrome exited before DevTools was ready (code ${chrome.exitCode ?? "unknown"})`);
      }

      const port = await readDevToolsPort(profileDir);
      if (port) {
        return port;
      }

      await delay(100);
    }

    throw new Error("Timed out waiting for Chrome DevTools port");
  }

  private async connectExistingBrowser() {
    const port = await readDevToolsPort(this.profileDir);
    if (!port) {
      return null;
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      return null;
    }
  }

  private async launchChromeAndConnect() {
    mkdirSync(this.profileDir, { recursive: true });

    const existing = await this.connectExistingBrowser();
    if (existing) {
      return existing;
    }

    const stalePortFile = join(this.profileDir, "DevToolsActivePort");
    if (existsSync(stalePortFile)) {
      try {
        unlinkSync(stalePortFile);
      } catch {
        // Ignore stale DevToolsActivePort cleanup failures and continue launching Chrome.
      }
    }

    const chrome = spawn(
      this.chromeExecutablePath,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        ...(this.chromeExtensionDir ? [
          `--disable-extensions-except=${this.chromeExtensionDir}`,
          `--load-extension=${this.chromeExtensionDir}`,
        ] : []),
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    this.chromeProcess = chrome;
    chrome.once("exit", () => {
      this.chromeProcess = null;
    });
    const port = await this.waitForBrowserReady(this.profileDir, chrome);
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }

  private async getBrowser() {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    if (!this.connectionPromise) {
      this.connectionPromise = this.launchChromeAndConnect()
        .then((browser) => {
          this.browser = browser;
          this.markHealthy();
          browser.on("disconnected", () => {
            this.tabs.clear();
            this.browser = null;
            this.connectionPromise = null;
            this.lastError = null;
          });
          return browser;
        })
        .catch((error) => {
          this.connectionPromise = null;
          this.markError(error);
          throw error;
        });
    }

    return this.connectionPromise;
  }

  private async getContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome default context is not available");
    }

    return context;
  }

  private async waitForSettledPage(page: Page, waitUntil: BrowserWaitUntil) {
    await page.waitForLoadState(waitUntil, { timeout: 10_000 }).catch(async () => {
      await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    });
  }

  private pruneClosedTabs() {
    for (const [tabId, record] of this.tabs) {
      if (record.page.isClosed()) {
        this.tabs.delete(tabId);
      }
    }
  }

  private async getTabRecord(tabId: string) {
    this.pruneClosedTabs();
    const record = this.tabs.get(tabId);
    if (!record) {
      throw new Error(`Unknown browser relay tab: ${tabId}`);
    }

    return record;
  }

  private trackTabNavigation(record: RelayTabRecord, url: string) {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) {
      return;
    }

    if (record.suppressNextHistoryEvent) {
      record.suppressNextHistoryEvent = false;
      return;
    }

    const currentUrl = record.history[record.historyIndex] ?? null;
    if (currentUrl === normalizedUrl) {
      return;
    }

    if (record.historyIndex < record.history.length - 1) {
      record.history = record.history.slice(0, record.historyIndex + 1);
    }

    record.history.push(normalizedUrl);
    record.historyIndex = record.history.length - 1;
  }

  async openTab(url?: string, waitUntil?: string) {
    try {
      const context = await this.getContext();
      const page = await context.newPage();
      await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => undefined);
      const tabId = randomUUID();
      const record: RelayTabRecord = {
        id: tabId,
        page,
        history: [],
        historyIndex: -1,
        suppressNextHistoryEvent: false,
      };
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) {
          return;
        }

        this.trackTabNavigation(record, frame.url());
      });
      if (url?.trim()) {
        await page.goto(url.trim(), {
          waitUntil: normalizeWaitUntil(waitUntil),
          timeout: 20_000,
        });
      }
      if (record.historyIndex < 0) {
        this.trackTabNavigation(record, page.url());
      }
      this.tabs.set(tabId, record);
      page.on("close", () => {
        this.tabs.delete(tabId);
      });
      this.markHealthy();
      const title = await page.title().catch(() => null);

      return {
        tabId,
        url: page.url(),
        title,
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async listTabs(): Promise<BrowserRelayTabsPayload> {
    try {
      this.pruneClosedTabs();
      this.markHealthy();
      const tabs = await Promise.all([...this.tabs.values()].map(async (record, index) => ({
        tabId: record.id,
        url: record.page.url(),
        title: await record.page.title().catch(() => null),
        active: index === this.tabs.size - 1,
      })));
      const activeTabId = tabs.find((tab) => tab.active)?.tabId ?? tabs.at(-1)?.tabId ?? null;

      return {
        backend: "desktop_chrome",
        activeTabId,
        tabs,
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async navigate(tabId: string, url: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      await record.page.goto(url, {
        waitUntil: normalizeWaitUntil(waitUntil),
        timeout: 20_000,
      });
      this.markHealthy();

      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async snapshot(tabId: string, options?: { maxTextLength?: number; maxElements?: number }) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return collectSnapshot(record.page, tabId, options);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async click(tabId: string, ref: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      const locator = await resolveRefLocator(record.page, ref);
      if (!locator) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.click({ timeout: 10_000 });
      await this.waitForSettledPage(record.page, normalizeWaitUntil(waitUntil));
      this.markHealthy();
      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async type(tabId: string, ref: string, text: string, submit: boolean) {
    try {
      const record = await this.getTabRecord(tabId);
      const locator = await resolveRefLocator(record.page, ref);
      if (!locator) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      const targetMeta = await locator.evaluate((element) => {
        const htmlElement = element as HTMLElement & {
          disabled?: boolean;
          readOnly?: boolean;
          type?: string;
          value?: string;
        };

        return {
          isContentEditable: htmlElement.isContentEditable,
          tagName: htmlElement.tagName.toLowerCase(),
          type: typeof htmlElement.type === "string" ? htmlElement.type.toLowerCase() : "",
        };
      });

      if (targetMeta.isContentEditable) {
        await locator.click({ timeout: 10_000 });
        await record.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await record.page.keyboard.press("Backspace");
        if (text) {
          await record.page.keyboard.type(text, { delay: 20 });
        }
        await locator.evaluate((element) => {
          const target = element as HTMLElement;
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
          }));
          target.dispatchEvent(new Event("change", {
            bubbles: true,
          }));
        });
      } else {
        await locator.fill(text, { timeout: 10_000 });
      }

      if (submit) {
        await locator.press("Enter", { timeout: 10_000 });
        await this.waitForSettledPage(record.page, "domcontentloaded");
      }
      this.markHealthy();

      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async screenshot(tabId: string, outputPath?: string, fullPage = true, ref?: string): Promise<BrowserScreenshotPayload> {
    try {
      const record = await this.getTabRecord(tabId);
      const targetPath = outputPath?.trim() || join(this.screenshotRoot, `browser-${Date.now()}-${tabId}.png`);
      mkdirSync(dirname(targetPath), { recursive: true });
      if (ref?.trim()) {
        const locator = await resolveRefLocator(record.page, ref.trim());
        if (!locator) {
          throw new Error(`No browser element matches ref ${ref.trim()}. Run browser_snapshot again to refresh refs.`);
        }
        await locator.waitFor({ state: "visible", timeout: 10_000 });
        await locator.screenshot({
          path: targetPath,
        });
      } else {
        await record.page.screenshot({
          path: targetPath,
          fullPage,
        });
      }
      this.markHealthy();

      return {
        path: targetPath,
        url: record.page.url(),
        backend: "desktop_chrome",
        tabId,
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async mediaProbe(tabId: string, ref?: string) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return await collectMediaProbe(record.page, tabId, ref);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async captureAudioClip(
    tabId: string,
    options?: {
      outputPath?: string;
      ref?: string;
      clipMs?: number;
    },
  ) {
    try {
      const record = await this.getTabRecord(tabId);
      const outputPath = options?.outputPath?.trim() || join(this.audioCaptureRoot, `browser-audio-${Date.now()}-${tabId}.webm`);
      ensureDirectoryForFile(outputPath);
      this.markHealthy();
      return await captureMediaAudioClip(record.page, tabId, {
        ...options,
        outputPath,
      });
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async readable(tabId: string, options?: { maxTextLength?: number; extractMain?: boolean }) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return await collectReadableContent(record.page, tabId, options);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async searchResults(tabId: string, maxResults: number) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return await collectSearchResults(record.page, tabId, maxResults);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async readDom(tabId: string, options?: { maxTextLength?: number; maxElements?: number }) {
    return this.snapshot(tabId, options);
  }

  async scroll(tabId: string, direction: "up" | "down" | "left" | "right", amount?: number) {
    try {
      const record = await this.getTabRecord(tabId);
      const distance = Math.max(50, Math.min(4_000, Math.round(amount ?? 800)));
      const deltas = {
        up: { x: 0, y: -distance },
        down: { x: 0, y: distance },
        left: { x: -distance, y: 0 },
        right: { x: distance, y: 0 },
      } as const;
      const delta = deltas[direction];
      await record.page.mouse.wheel(delta.x, delta.y);
      await delay(250);
      this.markHealthy();
      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async eval(tabId: string, expression: string): Promise<BrowserEvalPayload> {
    try {
      const record = await this.getTabRecord(tabId);
      const result = await record.page.evaluate(async ({ source }) => {
        const resolved = await (0, eval)(source);
        if (resolved === undefined || resolved === null) {
          return resolved ?? null;
        }

        if (typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean") {
          return resolved;
        }

        if (typeof resolved === "bigint") {
          return resolved.toString();
        }

        try {
          return JSON.parse(JSON.stringify(resolved));
        } catch {
          return String(resolved);
        }
      }, { source: expression });
      this.markHealthy();
      return {
        url: record.page.url(),
        backend: "desktop_chrome",
        tabId,
        result: sanitizeEvalResult(result),
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async back(tabId: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      if (record.historyIndex <= 0) {
        this.markHealthy();
        return collectSnapshot(record.page, tabId);
      }

      record.historyIndex -= 1;
      record.suppressNextHistoryEvent = true;
      await record.page.goto(record.history[record.historyIndex] ?? record.page.url(), {
        waitUntil: normalizeWaitUntil(waitUntil),
        timeout: 20_000,
      });
      await this.waitForSettledPage(record.page, normalizeWaitUntil(waitUntil));
      this.markHealthy();
      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async forward(tabId: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      if (record.historyIndex >= record.history.length - 1) {
        this.markHealthy();
        return collectSnapshot(record.page, tabId);
      }

      record.historyIndex += 1;
      record.suppressNextHistoryEvent = true;
      await record.page.goto(record.history[record.historyIndex] ?? record.page.url(), {
        waitUntil: normalizeWaitUntil(waitUntil),
        timeout: 20_000,
      });
      await this.waitForSettledPage(record.page, normalizeWaitUntil(waitUntil));
      this.markHealthy();
      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  getAttachedTabCount() {
    this.pruneClosedTabs();
    return this.tabs.size;
  }

  async launchChrome() {
    try {
      await this.getBrowser();
      this.markHealthy();
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async closeTab(tabId: string) {
    try {
      const record = await this.getTabRecord(tabId);
      this.tabs.delete(tabId);
      await record.page.close().catch(() => undefined);
      this.markHealthy();
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async dispose() {
    for (const tabId of [...this.tabs.keys()]) {
      await this.closeTab(tabId).catch(() => undefined);
    }

    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => undefined);
    }

    const chromeProcess = this.chromeProcess;
    this.chromeProcess = null;
    if (chromeProcess && chromeProcess.exitCode === null) {
      chromeProcess.kill("SIGTERM");
      await delay(300);
      if (chromeProcess.exitCode === null) {
        chromeProcess.kill("SIGKILL");
        await delay(100);
      }
    }

    this.browser = null;
    this.connectionPromise = null;
    this.lastError = null;
  }
}

export function createDefaultChromeRelayServiceOptions(userDataDir: string, chromeExtensionDir: string | null = null): ChromeRelayServiceOptions {
  const defaultChromeProfileDir = (() => {
    switch (process.platform) {
      case "darwin":
        return join(homedir(), "Library/Application Support/Google/Chrome");
      case "win32":
        return process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, "Google/Chrome/User Data")
          : join(homedir(), "AppData/Local/Google/Chrome/User Data");
      default:
        return join(homedir(), ".config/google-chrome");
    }
  })();

  return {
    chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    profileDir: process.env.ALICELOOP_CHROME_PROFILE_DIR?.trim() || defaultChromeProfileDir,
    screenshotRoot: join(userDataDir, DEFAULT_SCREENSHOT_ROOT_NAME),
    audioCaptureRoot: join(userDataDir, DEFAULT_AUDIO_CAPTURE_ROOT_NAME),
    chromeExtensionDir,
  };
}
