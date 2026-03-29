import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../../db/client";

export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";
export type BrowserBackendKind = "desktop_chrome" | "pinchtab";
export type BrowserChallengeKind =
  | "none"
  | "slider_captcha"
  | "captcha"
  | "sms_verification"
  | "two_factor"
  | "login_required"
  | "verification_required";

export interface BrowserChallengePayload {
  detected: boolean;
  kind: BrowserChallengeKind;
  userActionRequired: boolean;
  summary: string | null;
  keywords: string[];
}

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
  challenge: BrowserChallengePayload;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserScreenshotPayload {
  path: string;
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserReadablePayload {
  url: string;
  title: string;
  publishedAt: string | null;
  modifiedAt: string | null;
  pageText: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserRelayTabSummary {
  tabId: string;
  url: string;
  title: string | null;
  active: boolean;
}

export interface BrowserRelayTabsPayload {
  backend: BrowserBackendKind;
  activeTabId: string | null;
  tabs: BrowserRelayTabSummary[];
}

export interface BrowserEvalPayload {
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
  result: unknown;
}

export interface BrowserMediaCandidate {
  ref: string;
  tag: "video" | "audio";
  label: string;
  area: number;
  paused: boolean;
  muted: boolean;
  currentTime: number | null;
  duration: number | null;
  playbackRate: number;
  textTrackCount: number;
  activeCaptions: string[];
  canCaptureAudio: boolean;
}

export interface BrowserMediaProbePayload {
  url: string;
  title: string;
  backend: BrowserBackendKind;
  tabId: string;
  playerRef: string | null;
  subtitleSource: "textTracks" | "dom" | "none";
  subtitles: string[];
  candidates: BrowserMediaCandidate[];
}

export interface BrowserAudioCapturePayload {
  path: string | null;
  mediaType: string | null;
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
  ref: string | null;
  currentTime: number | null;
  durationMs: number;
  limitation: string | null;
}

export interface BrowserSessionRecord {
  sessionId: string;
  backend: BrowserBackendKind | null;
  preferredBackend: BrowserBackendKind | null;
  tabId: string | null;
  relayBaseUrl: string | null;
}

type CapturableMediaElement = HTMLMediaElement & {
  captureStream?: () => MediaStream;
};

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
  scroll(
    session: BrowserSessionRecord,
    direction: "up" | "down" | "left" | "right",
    amount?: number,
  ): Promise<BrowserSnapshotPayload>;
  screenshot(session: BrowserSessionRecord, outputPath?: string, fullPage?: boolean, ref?: string): Promise<BrowserScreenshotPayload>;
  mediaProbe(session: BrowserSessionRecord, ref?: string): Promise<BrowserMediaProbePayload>;
  captureAudioClip(
    session: BrowserSessionRecord,
    options?: {
      outputPath?: string;
      ref?: string;
      clipMs?: number;
    },
  ): Promise<BrowserAudioCapturePayload>;
  disposeSession(session: BrowserSessionRecord): Promise<void>;
}

const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;

let screenshotSequence = 0;
let browserAudioSequence = 0;

export function resolveDefaultScreenshotPath() {
  screenshotSequence += 1;
  return join(
    getDataDir(),
    "browser-screenshots",
    `aliceloop-browser-${Date.now()}-${screenshotSequence}.png`,
  );
}

export function resolveDefaultBrowserAudioPath() {
  browserAudioSequence += 1;
  return join(
    getDataDir(),
    "browser-watch-audio",
    `aliceloop-browser-audio-${Date.now()}-${browserAudioSequence}.webm`,
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
    return `${message}\nThe local browser backend is unavailable. Prefer the visible Chrome relay when it is healthy.`;
  }

  return message;
}

type BrowserSnapshotCore = Omit<BrowserSnapshotPayload, "backend" | "tabId" | "challenge">;
type BrowserPageLike = {
  evaluate(script: string): Promise<unknown>;
  url(): string;
};

function detectBrowserChallenge(payload: BrowserSnapshotCore): BrowserChallengePayload {
  const joined = [
    payload.title,
    payload.pageText,
    ...payload.headings.map((heading) => heading.text),
    ...payload.elements.flatMap((element) => [
      element.text,
      element.placeholder,
      element.name,
      element.value,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const matchedKeywords = new Set<string>();
  const collectMatches = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = joined.match(pattern);
      if (match?.[0]) {
        matchedKeywords.add(match[0]);
      }
    }
  };

  const sliderPatterns = [
    /拖动滑块/iu,
    /滑块验证/iu,
    /拖块/iu,
    /drag the slider/iu,
    /slide to verify/iu,
  ];
  const captchaPatterns = [
    /验证码/iu,
    /图形验证/iu,
    /captcha/iu,
    /recaptcha/iu,
    /hcaptcha/iu,
    /不是机器人/iu,
    /robot check/iu,
  ];
  const smsPatterns = [
    /短信验证码/iu,
    /手机验证码/iu,
    /\botp\b/iu,
    /sms code/iu,
    /one-time code/iu,
  ];
  const twoFactorPatterns = [
    /两步验证/iu,
    /二步验证/iu,
    /双重验证/iu,
    /\b2fa\b/iu,
    /two-factor/iu,
    /authenticator/iu,
  ];
  const loginPatterns = [
    /请先登录/iu,
    /登录后继续/iu,
    /扫码登录/iu,
    /\bsign[\s-]?in\b/iu,
    /\blog[\s-]?in\b/iu,
    /\bauth\b/iu,
  ];
  const verificationPatterns = [
    /安全验证/iu,
    /行为验证/iu,
    /人机验证/iu,
    /完成验证/iu,
    /verification required/iu,
    /verify/iu,
  ];

  let kind: BrowserChallengeKind = "none";
  let summary: string | null = null;

  if (sliderPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches([...sliderPatterns, ...verificationPatterns]);
    kind = "slider_captcha";
    summary = "检测到拖块/滑块验证，需要用户在可见浏览器里手动完成后再继续。";
  } else if (captchaPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches([...captchaPatterns, ...verificationPatterns]);
    kind = "captcha";
    summary = "检测到验证码校验页面，需要用户先手动完成验证。";
  } else if (smsPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches(smsPatterns);
    kind = "sms_verification";
    summary = "检测到短信验证码流程，需要用户输入验证码后再继续。";
  } else if (twoFactorPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches(twoFactorPatterns);
    kind = "two_factor";
    summary = "检测到双重验证流程，需要用户先完成验证。";
  } else if (verificationPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches(verificationPatterns);
    kind = "verification_required";
    summary = "检测到站点验证页面，需要用户先手动完成验证。";
  } else if (loginPatterns.some((pattern) => pattern.test(joined))) {
    collectMatches(loginPatterns);
    kind = "login_required";
    summary = "检测到登录/扫码页面；如果要继续后续账号操作，需要用户先完成登录。";
  }

  return {
    detected: kind !== "none",
    kind,
    userActionRequired: kind !== "none",
    summary,
    keywords: [...matchedKeywords].slice(0, 8),
  };
}

export async function collectSnapshot(
  page: BrowserPageLike,
  backend: BrowserBackendKind,
  tabId: string,
  options?: {
    maxTextLength?: number;
    maxElements?: number;
  },
): Promise<BrowserSnapshotPayload> {
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
  `) as BrowserSnapshotCore;

  return buildBrowserSnapshotPayload(result, backend, tabId);
}

export function buildBrowserSnapshotPayload(
  result: Omit<BrowserSnapshotPayload, "backend" | "tabId" | "challenge">,
  backend: BrowserBackendKind,
  tabId: string,
): BrowserSnapshotPayload {
  return {
    ...result,
    challenge: detectBrowserChallenge(result),
    backend,
    tabId,
  };
}

export function ensureDirectoryForFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

interface PageAudioCaptureResult {
  ok: boolean;
  ref: string | null;
  mediaType: string | null;
  currentTime: number | null;
  dataBase64?: string;
  limitation?: string;
}

function writeBase64File(targetPath: string, dataBase64: string) {
  ensureDirectoryForFile(targetPath);
  writeFileSync(targetPath, Buffer.from(dataBase64, "base64"));
}

async function evaluateMediaProbe(page: BrowserPageLike, ref?: string) {
  const payload = JSON.stringify({ ref: ref ?? null });
  return page.evaluate(`
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
  `);
}

export async function collectMediaProbe(
  page: BrowserPageLike,
  backend: BrowserBackendKind,
  tabId: string,
  ref?: string,
): Promise<BrowserMediaProbePayload> {
  const result = await evaluateMediaProbe(page, ref) as Omit<BrowserMediaProbePayload, "backend" | "tabId">;
  return {
    ...result,
    backend,
    tabId,
  };
}

export async function captureMediaAudioClip(
  page: BrowserPageLike,
  backend: BrowserBackendKind,
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
      backend,
      tabId,
      ref: captureResult.ref,
      currentTime: captureResult.currentTime,
      durationMs: requestedClipMs,
      limitation: captureResult.limitation ?? "The browser could not capture an audio clip.",
    };
  }

  const targetPath = options?.outputPath?.trim() || resolveDefaultBrowserAudioPath();
  writeBase64File(targetPath, captureResult.dataBase64);

  return {
    path: targetPath,
    mediaType: captureResult.mediaType,
    url: page.url(),
    backend,
    tabId,
    ref: captureResult.ref,
    currentTime: captureResult.currentTime,
    durationMs: requestedClipMs,
    limitation: null,
  };
}
