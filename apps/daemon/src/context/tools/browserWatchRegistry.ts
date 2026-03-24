import { randomUUID } from "node:crypto";
import { cleanupGeneratedAnalysisFile } from "../../services/multimodalAnalysisService";

export type VideoWatchMode = "audio+subtitle" | "subtitle+visual" | "visual-only";

export interface VideoWatchSession {
  watchId: string;
  sessionId: string;
  tabId: string;
  playerRef: string;
  goal: string | null;
  clipSeconds: number;
  mode: VideoWatchMode;
  rollingSummary: string;
  observations: string[];
  limitations: string[];
  lastCaption: string | null;
  lastSampleAt: string | null;
  lastCurrentTime: number | null;
  audioClipPath: string | null;
  lastAudioSummary: string | null;
  lastVisualSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

const watchSessions = new Map<string, VideoWatchSession>();

function nowIso() {
  return new Date().toISOString();
}

export function createVideoWatchSession(input: {
  sessionId: string;
  tabId: string;
  playerRef: string;
  goal?: string;
  clipSeconds?: number;
}): VideoWatchSession {
  const now = nowIso();
  const watchSession: VideoWatchSession = {
    watchId: `watch-${randomUUID()}`,
    sessionId: input.sessionId,
    tabId: input.tabId,
    playerRef: input.playerRef,
    goal: input.goal?.trim() || null,
    clipSeconds: Math.max(4, Math.min(12, Math.round(input.clipSeconds ?? 10))),
    mode: "visual-only",
    rollingSummary: "",
    observations: [],
    limitations: [],
    lastCaption: null,
    lastSampleAt: null,
    lastCurrentTime: null,
    audioClipPath: null,
    lastAudioSummary: null,
    lastVisualSummary: null,
    createdAt: now,
    updatedAt: now,
  };
  watchSessions.set(watchSession.watchId, watchSession);
  return watchSession;
}

export function getVideoWatchSession(watchId: string) {
  return watchSessions.get(watchId) ?? null;
}

export function listSessionVideoWatches(sessionId: string) {
  return [...watchSessions.values()]
    .filter((session) => session.sessionId === sessionId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function getLatestSessionVideoWatch(sessionId: string) {
  return listSessionVideoWatches(sessionId)[0] ?? null;
}

export function findReusableVideoWatchSession(sessionId: string, tabId: string, playerRef: string) {
  return listSessionVideoWatches(sessionId).find((session) => {
    return session.tabId === tabId && session.playerRef === playerRef;
  }) ?? null;
}

export async function updateVideoWatchSession(
  watchId: string,
  patch: Partial<Omit<VideoWatchSession, "watchId" | "sessionId" | "createdAt">>,
) {
  const current = watchSessions.get(watchId);
  if (!current) {
    return null;
  }

  if (patch.audioClipPath && current.audioClipPath && current.audioClipPath !== patch.audioClipPath) {
    await cleanupGeneratedAnalysisFile(current.audioClipPath);
  }

  const next: VideoWatchSession = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  watchSessions.set(watchId, next);
  return next;
}

export async function stopVideoWatchSession(watchId: string) {
  const current = watchSessions.get(watchId);
  if (!current) {
    return null;
  }

  watchSessions.delete(watchId);
  await cleanupGeneratedAnalysisFile(current.audioClipPath);
  return current;
}

export async function clearSessionVideoWatches(sessionId: string) {
  const sessions = listSessionVideoWatches(sessionId);
  for (const session of sessions) {
    watchSessions.delete(session.watchId);
    await cleanupGeneratedAnalysisFile(session.audioClipPath);
  }
}
