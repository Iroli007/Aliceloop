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
import { playwrightBrowserBackend } from "./playwrightBrowserBackend";
import { type BrowserBackend, type BrowserSessionRecord, normalizeWaitUntil } from "./browserTypes";
import {
  cleanupGeneratedAnalysisFile,
  describeImageFile,
  synthesizeRollingVideoSummary,
  understandAudioFile,
} from "../../services/multimodalAnalysisService";

const DEFAULT_BROWSER_SESSION_ID = "default-browser-session";

function getBrowserBackend(session: BrowserSessionRecord): BrowserBackend {
  return session.backend === "desktop_chrome" ? desktopChromeRelayBackend : playwrightBrowserBackend;
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

      throw new Error(`desktop_browser_unavailable: ${error.message}`);
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
      description:
        "Open a URL in a browser and return a structured page snapshot with element refs. " +
        "On Aliceloop Desktop this prefers a visible Google Chrome relay; otherwise it falls back to local Playwright.",
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

    browser_click: tool({
      description:
        "Click an interactive page element by its ref from browser_snapshot, then return the refreshed page snapshot.",
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
      description:
        "Fill a text field by its ref from browser_snapshot, optionally pressing Enter, and return the refreshed page snapshot.",
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

    browser_screenshot: tool({
      description:
        "Save a screenshot of the current page or a specific page element to disk and return the output path.",
      inputSchema: z.object({
        outputPath: z.string().optional().describe("Optional output path for the PNG file"),
        ref: z.string().optional().describe("Optional element ref from browser_snapshot; when provided, capture only that element"),
        fullPage: z.boolean().optional().default(true).describe("Capture the full page instead of only the viewport"),
      }),
      execute: async ({ outputPath, ref, fullPage }) => {
        const result = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.screenshot(session, outputPath, fullPage, ref);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    browser_media_probe: tool({
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
