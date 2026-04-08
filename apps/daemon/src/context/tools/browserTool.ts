import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  createVideoWatchSession,
  findReusableVideoWatchSession,
  getVideoWatchSession,
  getLatestSessionVideoWatch,
  stopVideoWatchSession,
  updateVideoWatchSession,
  type VideoWatchMode,
} from "./browserWatchRegistry";
import { clearBrowserSession, previewBrowserRuntime, refreshDesktopRelaySession, resolveBrowserSession } from "./browserSessionRegistry";
import { desktopChromeRelayBackend, isDesktopBrowserUnavailableError } from "./desktopChromeRelayBackend";
import { isPinchTabUnavailableError, pinchTabBrowserBackend } from "./pinchTabBrowserBackend";
import { type BrowserBackend, type BrowserSessionRecord, normalizeWaitUntil } from "./browserTypes";
import {
  cleanupGeneratedAnalysisFile,
  describeImageFile,
  synthesizeRollingVideoSummary,
  understandAudioFile,
} from "../../services/multimodalAnalysisService";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

const DEFAULT_BROWSER_SESSION_ID = "default-browser-session";
const DEFAULT_WAIT_TIMEOUT_SECONDS = 12;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 800;

type BrowserFindMatch = {
  ref: string;
  score: number;
  reason: string;
  tag: string;
  role: string;
  text: string;
  name: string;
  placeholder: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMatchText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function summarizeElementText(element: {
  text: string;
  name: string;
  placeholder: string;
  tag: string;
  role: string;
}) {
  return dedupeStrings([element.text, element.name, element.placeholder, element.tag, element.role]).join(" / ");
}

function findSnapshotMatches(
  snapshot: {
    elements: Array<{
      ref: string;
      tag: string;
      role: string;
      text: string;
      name: string;
      placeholder: string;
    }>;
  },
  input: {
    query: string;
    tag?: string;
    role?: string;
    maxResults?: number;
  },
) {
  const query = normalizeMatchText(input.query);
  const wantedTag = normalizeMatchText(input.tag);
  const wantedRole = normalizeMatchText(input.role);
  const queryTokens = query.split(/\s+/).filter(Boolean);

  const matches: BrowserFindMatch[] = [];
  for (const element of snapshot.elements) {
    if (wantedTag && normalizeMatchText(element.tag) !== wantedTag) {
      continue;
    }
    if (wantedRole && normalizeMatchText(element.role) !== wantedRole) {
      continue;
    }

    const fields = [
      { key: "text", value: normalizeMatchText(element.text), weight: 6 },
      { key: "name", value: normalizeMatchText(element.name), weight: 5 },
      { key: "placeholder", value: normalizeMatchText(element.placeholder), weight: 4 },
      { key: "tag", value: normalizeMatchText(element.tag), weight: 2 },
      { key: "role", value: normalizeMatchText(element.role), weight: 2 },
    ];

    let score = 0;
    let reason = "";
    for (const field of fields) {
      if (!field.value) {
        continue;
      }
      if (field.value === query) {
        score = field.weight + 10;
        reason = `exact_${field.key}`;
        break;
      }
      if (field.value.includes(query)) {
        score = Math.max(score, field.weight + 6);
        reason = reason || `contains_${field.key}`;
      }
    }

    if (score === 0 && queryTokens.length > 1) {
      const combined = fields.map((field) => field.value).join(" ");
      const tokenHits = queryTokens.filter((token) => combined.includes(token)).length;
      if (tokenHits > 0) {
        score = tokenHits;
        reason = "token_match";
      }
    }

    if (score > 0) {
      matches.push({
        ref: element.ref,
        score,
        reason,
        tag: element.tag,
        role: element.role,
        text: element.text,
        name: element.name,
        placeholder: element.placeholder,
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref));
  return matches.slice(0, input.maxResults ?? 5);
}

function getBrowserBackend(session: BrowserSessionRecord): BrowserBackend {
  return session.backend === "desktop_chrome" ? desktopChromeRelayBackend : pinchTabBrowserBackend;
}

async function executeBrowserOperation<T>(
  sessionId: string,
  operation: (backend: BrowserBackend, session: BrowserSessionRecord) => Promise<T>,
) {
  const session = resolveBrowserSession(sessionId);
  const backend = getBrowserBackend(session);

  try {
    return await operation(backend, session);
  } catch (error) {
    if (session.backend === "desktop_chrome" && isDesktopBrowserUnavailableError(error)) {
      const refreshed = refreshDesktopRelaySession(session);
      if (refreshed) {
        try {
          return await operation(desktopChromeRelayBackend, refreshed);
        } catch (retryError) {
          if (isDesktopBrowserUnavailableError(retryError)) {
            throw new Error(`desktop_browser_unavailable: ${retryError.message}`);
          }

          throw retryError;
        }
      }

      session.backend = null;
      session.tabId = null;
      session.relayBaseUrl = null;
      const fallbackSession = resolveBrowserSession(sessionId);
      if (fallbackSession.backend !== "desktop_chrome") {
        return operation(getBrowserBackend(fallbackSession), fallbackSession);
      }

      throw new Error(`desktop_browser_unavailable: ${error.message}`);
    }

    if (session.backend === "pinchtab" && isPinchTabUnavailableError(error)) {
      session.backend = null;
      session.tabId = null;
      const fallbackSession = resolveBrowserSession(sessionId);
      if (fallbackSession.backend !== "pinchtab") {
        return operation(getBrowserBackend(fallbackSession), fallbackSession);
      }

      throw new Error(`pinchtab_unavailable: ${error.message}`);
    }

    throw error;
  }
}

export function getBrowserToolRuntime(sessionId: string) {
  const runtime = previewBrowserRuntime(sessionId);
  return {
    backend: runtime.backend,
    tabId: runtime.tabId,
  };
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function joinSubtitleEvidence(subtitles: string[]) {
  return dedupeStrings(subtitles).join(" / ") || null;
}

function deriveWatchMode(hasAudioEvidence: boolean, hasSubtitleEvidence: boolean): VideoWatchMode {
  if (hasAudioEvidence || hasSubtitleEvidence) {
    return hasAudioEvidence ? "audio+subtitle" : "subtitle+visual";
  }

  return "visual-only";
}

export function createBrowserTools(sessionId = DEFAULT_BROWSER_SESSION_ID): ToolSet {
  const dispose = async () => {
    const session = resolveBrowserSession(sessionId);
    await getBrowserBackend(session).disposeSession(session);
    clearBrowserSession(sessionId);
  };

  const tools: ToolSet = {
    browser_navigate: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Open a URL in the current browser tab and return a structured page snapshot with element refs. " +
        "This prefers the visible Aliceloop Desktop Chrome relay when it is healthy, and falls back to PinchTab only when the relay is unavailable.",
      inputSchema: z.object({
        url: z.string().min(1).describe("Target URL to open"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate; defaults to domcontentloaded"),
      }),
      execute: async ({ url, waitUntil }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.navigate(session, url, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_snapshot: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Capture the current page state as JSON, including headings, visible text, and interactive element refs " +
        "from the current browser tab.",
      inputSchema: z.object({
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxTextLength, maxElements }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.snapshot(session, {
            maxTextLength,
            maxElements,
          });
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_find: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Find likely interactive elements on the current page by natural-language query, text, placeholder, role, or tag, and return ranked matches without clicking anything.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Natural-language hint such as 搜索框, login button, 发布, submit, or settings"),
        tag: z.string().optional().describe("Optional HTML tag filter such as input, button, or a"),
        role: z.string().optional().describe("Optional accessibility role filter"),
        maxResults: z.number().int().min(1).max(10).optional().default(5),
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(150).optional(),
      }),
      execute: async ({ query, tag, role, maxResults, maxTextLength, maxElements }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.snapshot(session, {
            maxTextLength,
            maxElements,
          });
        });
        const matches = findSnapshotMatches(snapshot, {
          query,
          tag,
          role,
          maxResults,
        });

        return JSON.stringify({
          ok: matches.length > 0,
          query,
          backend: snapshot.backend,
          tabId: snapshot.tabId,
          url: snapshot.url,
          title: snapshot.title,
          matches: matches.map((match) => ({
            ref: match.ref,
            score: match.score,
            reason: match.reason,
            preview: summarizeElementText(match),
            tag: match.tag,
            role: match.role,
          })),
        }, null, 2);
      },
    }),

    browser_wait: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Wait for text, a specific ref, or a likely element query to appear on the current page, polling snapshots until it shows up or the timeout expires.",
      inputSchema: z.object({
        text: z.string().optional().describe("Wait until this text appears in the page text, title, or headings"),
        ref: z.string().optional().describe("Wait until this specific ref appears in the current snapshot"),
        query: z.string().optional().describe("Wait until browser_find can locate a likely matching element"),
        tag: z.string().optional().describe("Optional tag filter used with query"),
        role: z.string().optional().describe("Optional role filter used with query"),
        timeoutSeconds: z.number().min(1).max(60).optional().default(DEFAULT_WAIT_TIMEOUT_SECONDS),
        pollIntervalMs: z.number().int().min(200).max(5000).optional().default(DEFAULT_WAIT_POLL_INTERVAL_MS),
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(150).optional(),
      }).refine((value) => Boolean(value.text?.trim() || value.ref?.trim() || value.query?.trim()), {
        message: "Provide at least one of text, ref, or query.",
      }),
      execute: async ({ text, ref, query, tag, role, timeoutSeconds, pollIntervalMs, maxTextLength, maxElements }) => {
        const deadline = Date.now() + timeoutSeconds * 1000;
        const wantedText = text?.trim().toLowerCase() ?? "";
        const wantedRef = ref?.trim() ?? "";
        const wantedQuery = query?.trim() ?? "";

        let lastSnapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.snapshot(session, {
            maxTextLength,
            maxElements,
          });
        });

        while (true) {
          const combinedText = [
            lastSnapshot.title,
            lastSnapshot.pageText,
            ...lastSnapshot.headings.map((heading) => heading.text),
          ].join(" ").toLowerCase();
          const refMatch = wantedRef
            ? lastSnapshot.elements.find((element) => element.ref === wantedRef) ?? null
            : null;
          const queryMatches = wantedQuery
            ? findSnapshotMatches(lastSnapshot, {
              query: wantedQuery,
              tag,
              role,
              maxResults: 3,
            })
            : [];

          if ((wantedText && combinedText.includes(wantedText)) || refMatch || queryMatches.length > 0) {
            return JSON.stringify({
              ok: true,
              matched: {
                text: Boolean(wantedText && combinedText.includes(wantedText)),
                ref: refMatch?.ref ?? null,
                query: queryMatches[0]?.ref ?? null,
              },
              matches: queryMatches.map((match) => ({
                ref: match.ref,
                score: match.score,
                reason: match.reason,
                preview: summarizeElementText(match),
              })),
              snapshot: lastSnapshot,
            }, null, 2);
          }

          if (Date.now() >= deadline) {
            return JSON.stringify({
              ok: false,
              reason: "timeout",
              timeoutSeconds,
              snapshot: lastSnapshot,
            }, null, 2);
          }

          await sleep(pollIntervalMs);
          lastSnapshot = await executeBrowserOperation(sessionId, (backend, session) => {
            return backend.snapshot(session, {
              maxTextLength,
              maxElements,
            });
          });
        }
      },
    }),

    browser_click: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Click an interactive page element by its ref from browser_snapshot, then return the refreshed page snapshot so the result can be verified immediately.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Post-click readiness gate; defaults to domcontentloaded"),
      }),
      execute: async ({ ref, waitUntil }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.click(session, ref, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_type: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Fill a text field by its ref from browser_snapshot, optionally pressing Enter, and return the refreshed page snapshot so the result can be verified immediately.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        text: z.string().describe("Text to enter into the element"),
        submit: z.boolean().optional().default(false).describe("Press Enter after typing"),
      }),
      execute: async ({ ref, text, submit }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.type(session, ref, text, submit);
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_scroll: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Scroll the current page and return a refreshed snapshot. Use this on lazy-loaded pages such as social feeds, video pages, and comment sections before looking for elements that are not yet in the DOM snapshot.",
      inputSchema: z.object({
        direction: z.enum(["up", "down", "left", "right"]).optional().default("down"),
        amount: z.number().int().min(50).max(4_000).optional().describe("Approximate scroll distance in CSS pixels"),
      }),
      execute: async ({ direction, amount }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.scroll(session, direction, amount);
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_batch: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Run a short sequence of browser actions in one tool call on the current browser tab, such as navigate -> find target -> click/type, and return the final page snapshot plus step summaries.",
      inputSchema: z.object({
        actions: z.array(z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("navigate"),
            url: z.string().min(1),
            waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
          }),
          z.object({
            kind: z.literal("click"),
            ref: z.string().min(1),
            waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
          }),
          z.object({
            kind: z.literal("type"),
            ref: z.string().min(1),
            text: z.string(),
            submit: z.boolean().optional().default(false),
          }),
        ])).min(1).max(8),
      }),
      execute: async ({ actions }) => {
        let finalSnapshot: unknown = null;
        const steps: Array<Record<string, unknown>> = [];

        for (const action of actions) {
          if (action.kind === "navigate") {
            finalSnapshot = await executeBrowserOperation(sessionId, (backend, session) => {
              return backend.navigate(session, action.url, normalizeWaitUntil(action.waitUntil));
            });
            steps.push({
              kind: action.kind,
              url: action.url,
              backend: (finalSnapshot as { backend?: string }).backend ?? null,
            });
            continue;
          }

          if (action.kind === "click") {
            finalSnapshot = await executeBrowserOperation(sessionId, (backend, session) => {
              return backend.click(session, action.ref, normalizeWaitUntil(action.waitUntil));
            });
            steps.push({
              kind: action.kind,
              ref: action.ref,
              backend: (finalSnapshot as { backend?: string }).backend ?? null,
            });
            continue;
          }

          finalSnapshot = await executeBrowserOperation(sessionId, (backend, session) => {
            return backend.type(session, action.ref, action.text, action.submit ?? false);
          });
          steps.push({
            kind: action.kind,
            ref: action.ref,
            submit: action.submit ?? false,
            backend: (finalSnapshot as { backend?: string }).backend ?? null,
          });
        }

        return JSON.stringify({
          ok: true,
          steps,
          finalSnapshot,
        }, null, 2);
      },
    }),

    browser_screenshot: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Save a screenshot of the current page or a specific page element to disk. When the DOM snapshot is unclear, you can also ask this tool to analyze the screenshot and return visible UI clues such as bottom input bars, send buttons, and likely next actions.",
      inputSchema: z.object({
        outputPath: z.string().optional().describe("Optional output path for the PNG file"),
        ref: z.string().optional().describe("Optional element ref from browser_snapshot; when provided, capture only that element"),
        fullPage: z.boolean().optional().default(true).describe("Capture the full page instead of only the viewport"),
        analyze: z.boolean().optional().default(false).describe("Also analyze the screenshot contents for visible controls and likely next actions"),
        prompt: z.string().max(800).optional().describe("Optional analysis prompt used when analyze is true"),
      }),
      execute: async ({ outputPath, ref, fullPage, analyze, prompt }) => {
        const result = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.screenshot(session, outputPath, fullPage, ref);
        });
        if (!analyze) {
          return JSON.stringify(result, null, 2);
        }

        const analysisPrompt = prompt?.trim() || [
          "Analyze this browser screenshot for the next UI action.",
          "Focus on visible input boxes, comment composers, bottom bars, send/publish buttons, folded panels, and anything the agent can click or type into next.",
          "If the target is visible near the bottom of the screenshot, say that explicitly.",
          "Do not invent text that is not readable.",
        ].join(" ");
        const visual = await describeImageFile(sessionId, {
          path: result.path,
          prompt: analysisPrompt,
          allowInternalPath: true,
        });

        return JSON.stringify({
          ...result,
          visual,
        }, null, 2);
      },
    }),

    browser_media_probe: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Inspect the current page for visible HTML5 video/audio elements, playback state, subtitle signals, and the best player ref.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Optional media element ref from browser_snapshot"),
      }),
      execute: async ({ ref }) => {
        const result = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.mediaProbe(session, ref);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    browser_video_watch_start: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Start or resume a reusable watch session for the current video/audio player so later polls can summarize what the video says and shows.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Optional media element ref from browser_snapshot or browser_media_probe"),
        goal: z.string().max(400).optional().describe("Optional user goal, such as summarize, explain, or focus on a question"),
        clipSeconds: z.number().int().min(4).max(12).optional().describe("Audio sample length for each poll"),
      }),
      execute: async ({ ref, goal, clipSeconds }) => {
        const probe = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.mediaProbe(session, ref);
        });

        const playerRef = ref?.trim() || probe.playerRef;
        if (!playerRef) {
          return JSON.stringify({
            ok: false,
            reason: "no_visible_media",
            detail: "当前页面没有可绑定的可见 video/audio 元素。先进入真正播放页，再调用 browser_video_watch_start。",
            probe,
          }, null, 2);
        }

        const existing = findReusableVideoWatchSession(sessionId, probe.tabId, playerRef);
        const watch = existing ?? createVideoWatchSession({
          sessionId,
          tabId: probe.tabId,
          playerRef,
          goal,
          clipSeconds,
        });
        const subtitleText = joinSubtitleEvidence(probe.subtitles);
        const mode = deriveWatchMode(false, Boolean(subtitleText));
        const updated = await updateVideoWatchSession(watch.watchId, {
          goal: goal?.trim() || watch.goal,
          clipSeconds: Math.max(4, Math.min(12, Math.round(clipSeconds ?? watch.clipSeconds))),
          mode,
          lastCaption: subtitleText,
          lastCurrentTime: probe.candidates.find((candidate) => candidate.ref === playerRef)?.currentTime ?? null,
          limitations: probe.candidates.length === 0
            ? ["当前页面没有检测到可见的媒体元素。"]
            : [],
        });

        return JSON.stringify({
          ok: true,
          watchId: watch.watchId,
          reused: Boolean(existing),
          playerRef,
          goal: updated?.goal ?? watch.goal,
          clipSeconds: updated?.clipSeconds ?? watch.clipSeconds,
          mode,
          subtitles: probe.subtitles,
          rollingSummary: updated?.rollingSummary ?? watch.rollingSummary,
          observations: updated?.observations ?? watch.observations,
          probe,
        }, null, 2);
      },
    }),

    browser_video_watch_poll: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Poll the current or specified watch session to capture fresh subtitle/audio/visual evidence and update the rolling video summary.",
      inputSchema: z.object({
        watchId: z.string().min(1).optional().describe("Optional watch session id returned by browser_video_watch_start; omit to reuse the latest active watch in this conversation"),
      }),
      execute: async ({ watchId }) => {
        const resolvedWatchId = watchId?.trim() || getLatestSessionVideoWatch(sessionId)?.watchId || "";
        const watch = getVideoWatchSession(resolvedWatchId);
        if (!watch || watch.sessionId !== sessionId) {
          return JSON.stringify({
            ok: false,
            reason: "watch_not_found",
            detail: "未找到可复用的 watch session，先重新调用 browser_video_watch_start。",
          }, null, 2);
        }

        const probe = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.mediaProbe(session, watch.playerRef);
        });
        const targetCandidate = probe.candidates.find((candidate) => candidate.ref === watch.playerRef)
          ?? probe.candidates[0]
          ?? null;
        const subtitleText = joinSubtitleEvidence(probe.subtitles);
        const subtitleDelta = subtitleText && subtitleText !== watch.lastCaption ? subtitleText : null;

        let audioResult: Awaited<ReturnType<typeof understandAudioFile>> | null = null;
        let visualSummary: string | null = null;
        let visualObservations: string[] = [];
        const limitations = dedupeStrings([
          ...watch.limitations,
          ...(targetCandidate?.canCaptureAudio === false ? ["当前播放器不支持 captureStream 音频采样。"] : []),
          ...(targetCandidate?.paused ? ["当前播放器已暂停，无法采样新的声音。"] : []),
        ]);

        const playbackProgressDelta = targetCandidate?.currentTime != null && watch.lastCurrentTime != null
          ? targetCandidate.currentTime - watch.lastCurrentTime
          : null;
        const shouldSampleAudio = Boolean(targetCandidate?.canCaptureAudio)
          && !targetCandidate?.paused
          && (watch.lastSampleAt == null || playbackProgressDelta == null || playbackProgressDelta >= Math.max(4, watch.clipSeconds - 2));

        if (shouldSampleAudio) {
          const capture = await executeBrowserOperation(sessionId, (backend, session) => {
            return backend.captureAudioClip(session, {
              ref: watch.playerRef,
              clipMs: watch.clipSeconds * 1_000,
            });
          });

          if (capture.path && !capture.limitation) {
            audioResult = await understandAudioFile(sessionId, {
              path: capture.path,
              instruction: watch.goal
                ? `${watch.goal}。请重点提取这段视频音频在这 ${watch.clipSeconds} 秒内说了什么。`
                : "请总结这段网页视频音频刚刚说了什么。",
              allowInternalPath: true,
            });
            limitations.push(...audioResult.limitations);
            await updateVideoWatchSession(resolvedWatchId, {
              audioClipPath: capture.path,
            });
          } else if (capture.limitation) {
            limitations.push(capture.limitation);
          }
        }

        const shouldDescribeVisual = !subtitleDelta && !audioResult?.summary;
        if (shouldDescribeVisual) {
          const screenshot = await executeBrowserOperation(sessionId, (backend, session) => {
            return backend.screenshot(session, undefined, false, watch.playerRef);
          });
          try {
            const visualResult = await describeImageFile(sessionId, {
              path: screenshot.path,
              prompt: watch.goal
                ? `用户目标：${watch.goal}。请只描述当前视频播放器里这一帧真正能看到的内容，不要脑补剧情。`
                : "请简短描述当前视频播放器里这一帧真正能看到的内容，不要脑补剧情。",
              allowInternalPath: true,
            });
            visualSummary = visualResult.summary;
            visualObservations = visualResult.observations;
            limitations.push(...visualResult.limitations);
          } finally {
            await cleanupGeneratedAnalysisFile(screenshot.path);
          }
        }

        const mode = deriveWatchMode(Boolean(audioResult?.summary), Boolean(subtitleText));
        const rolling = await synthesizeRollingVideoSummary({
          goal: watch.goal ?? undefined,
          previousSummary: watch.rollingSummary,
          currentTimeSeconds: targetCandidate?.currentTime ?? null,
          durationSeconds: targetCandidate?.duration ?? null,
          subtitles: subtitleDelta ? [subtitleDelta] : [],
          audioSummary: audioResult?.summary ?? null,
          visualSummary,
          limitations,
        });

        const updated = await updateVideoWatchSession(resolvedWatchId, {
          goal: watch.goal,
          tabId: probe.tabId,
          mode,
          lastCaption: subtitleText,
          lastSampleAt: new Date().toISOString(),
          lastCurrentTime: targetCandidate?.currentTime ?? null,
          rollingSummary: rolling.rollingSummary,
          observations: rolling.observations,
          limitations: dedupeStrings(limitations).slice(0, 10),
          lastAudioSummary: audioResult?.summary ?? watch.lastAudioSummary,
          lastVisualSummary: visualSummary ?? watch.lastVisualSummary,
        });

        return JSON.stringify({
          ok: true,
          watchId: resolvedWatchId,
          mode,
          playerRef: updated?.playerRef ?? watch.playerRef,
          currentTime: targetCandidate?.currentTime ?? null,
          duration: targetCandidate?.duration ?? null,
          subtitles: subtitleDelta ? [subtitleDelta] : [],
          audio: audioResult
            ? {
                transcript: audioResult.transcript,
                summary: audioResult.summary,
                moments: audioResult.moments,
              }
            : null,
          visual: visualSummary
            ? {
                summary: visualSummary,
                observations: visualObservations,
              }
            : null,
          rollingSummary: updated?.rollingSummary ?? rolling.rollingSummary,
          observations: updated?.observations ?? rolling.observations,
          limitations: updated?.limitations ?? dedupeStrings(limitations),
        }, null, 2);
      },
    }),

    browser_video_watch_stop: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Stop the current or specified watch session and return the final rolling summary collected so far.",
      inputSchema: z.object({
        watchId: z.string().min(1).optional().describe("Optional watch session id returned by browser_video_watch_start; omit to stop the latest active watch in this conversation"),
      }),
      execute: async ({ watchId }) => {
        const resolvedWatchId = watchId?.trim() || getLatestSessionVideoWatch(sessionId)?.watchId || "";
        const current = getVideoWatchSession(resolvedWatchId);
        if (!current || current.sessionId !== sessionId) {
          return JSON.stringify({
            ok: false,
            reason: "watch_not_found",
            detail: "未找到可停止的 watch session。",
          }, null, 2);
        }
        const stopped = await stopVideoWatchSession(resolvedWatchId);
        if (!stopped) {
          return JSON.stringify({
            ok: false,
            reason: "watch_not_found",
            detail: "未找到可停止的 watch session。",
          }, null, 2);
        }

        return JSON.stringify({
          ok: true,
          watchId: stopped.watchId,
          mode: stopped.mode,
          playerRef: stopped.playerRef,
          rollingSummary: stopped.rollingSummary,
          observations: stopped.observations,
          limitations: stopped.limitations,
        }, null, 2);
      },
    }),
  };

  for (const browserTool of Object.values(tools)) {
    Object.assign(browserTool, {
      __dispose: () => dispose(),
    });
  }

  return tools;
}
