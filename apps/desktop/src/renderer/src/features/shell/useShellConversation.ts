import {
  previewSessionSnapshot,
  previewSessionThreads,
  primarySessionId,
  type JobRunDetail,
  type RuntimePresence,
  type SessionEvent,
  type SessionMessage,
  type SessionSnapshot,
  type SessionThreadSummary,
  type StudyArtifact,
} from "@aliceloop/runtime-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const desktopSessionDeviceStorageKey = "aliceloop-shell-session-device-id";
const activeSessionStorageKey = "aliceloop-shell-active-session-id";
const localDraftSessionId = "__local_draft__";
const streamRetryMs = 2_000;

interface SendResult {
  ok: boolean;
  error?: string;
}

interface CreateSessionResult extends SendResult {
  sessionId?: string;
}

export interface ShellConversationState {
  status: "loading" | "ready" | "error";
  sessionId: string;
  sessionTitle: string;
  threads: SessionThreadSummary[];
  messages: SessionMessage[];
  runtimePresence: RuntimePresence;
  latestReply: SessionMessage | null;
  latestJob: JobRunDetail | null;
  latestArtifact: StudyArtifact | null;
  pending: boolean;
  error?: string;
  selectSession(sessionId: string): void;
  createSession(): Promise<CreateSessionResult>;
  sendMessage(content: string): Promise<SendResult>;
}

function getStableDesktopSessionDeviceId() {
  if (typeof window === "undefined") {
    return "desktop-session-server";
  }

  const existing = window.localStorage.getItem(desktopSessionDeviceStorageKey);
  if (existing) {
    return existing;
  }

  const next = `desktop-session-${crypto.randomUUID()}`;
  window.localStorage.setItem(desktopSessionDeviceStorageKey, next);
  return next;
}

function getStoredActiveSessionId() {
  if (typeof window === "undefined") {
    return primarySessionId;
  }

  return window.localStorage.getItem(activeSessionStorageKey) ?? primarySessionId;
}

function rememberActiveSessionId(sessionId: string) {
  if (typeof window === "undefined") {
    return;
  }

  if (sessionId === localDraftSessionId) {
    window.localStorage.removeItem(activeSessionStorageKey);
    return;
  }

  window.localStorage.setItem(activeSessionStorageKey, sessionId);
}

function upsertMessage(messages: SessionMessage[], message: SessionMessage) {
  const next = messages.filter((item) => item.id !== message.id && item.clientMessageId !== message.clientMessageId);
  next.push(message);
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return next;
}

function upsertJob(jobs: JobRunDetail[], job: JobRunDetail) {
  const next = jobs.filter((item) => item.id !== job.id);
  next.unshift(job);
  next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return next;
}

function upsertArtifact(artifacts: StudyArtifact[], artifact: StudyArtifact) {
  const next = artifacts.filter((item) => item.id !== artifact.id);
  next.unshift(artifact);
  next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return next;
}

function upsertThread(threads: SessionThreadSummary[], thread: SessionThreadSummary) {
  const next = threads.filter((item) => item.id !== thread.id);
  next.unshift(thread);
  next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return next;
}

function buildThreadFromSnapshot(snapshot: SessionSnapshot): SessionThreadSummary {
  const latestMessage = snapshot.messages.at(-1) ?? null;
  return {
    id: snapshot.session.id,
    title: snapshot.session.title,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    messageCount: snapshot.messages.length,
    latestMessagePreview: latestMessage?.content ?? null,
    latestMessageAt: latestMessage?.createdAt ?? null,
  };
}

function createLocalDraftSnapshot(current: SessionSnapshot): SessionSnapshot {
  const now = new Date().toISOString();

  return {
    ...current,
    session: {
      id: localDraftSessionId,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
    },
    messages: [],
    attachments: [],
    jobs: [],
    artifacts: [],
    lastEventSeq: 0,
  };
}

function createEmptySnapshotFromThread(thread: SessionThreadSummary, current: SessionSnapshot): SessionSnapshot {
  return {
    ...current,
    session: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    messages: [],
    attachments: [],
    jobs: [],
    artifacts: [],
    lastEventSeq: 0,
  };
}

function applySessionEvent(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  switch (event.type) {
    case "message.created":
    case "message.acked":
    case "message.updated": {
      const message = (event.payload as { message?: SessionMessage }).message;
      if (!message) {
        return snapshot;
      }

      return {
        ...snapshot,
        session: {
          ...snapshot.session,
          updatedAt: event.createdAt,
        },
        messages: upsertMessage(snapshot.messages, message),
      };
    }
    case "job.updated": {
      const job = (event.payload as { job?: JobRunDetail }).job;
      if (!job) {
        return snapshot;
      }

      return {
        ...snapshot,
        jobs: upsertJob(snapshot.jobs, job),
      };
    }
    case "artifact.created":
    case "artifact.block.created":
    case "artifact.block.append":
    case "artifact.done":
    case "artifact.updated": {
      const artifact = (event.payload as { artifact?: StudyArtifact }).artifact;
      if (!artifact) {
        return snapshot;
      }

      return {
        ...snapshot,
        artifacts: upsertArtifact(snapshot.artifacts, artifact),
      };
    }
    case "presence.updated":
    case "runtime.offline": {
      const payload = event.payload as { runtimePresence?: RuntimePresence };
      return {
        ...snapshot,
        runtimePresence: payload.runtimePresence ?? snapshot.runtimePresence,
      };
    }
    default:
      return snapshot;
  }
}

async function fetchSessionThreads(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/sessions`);
  if (!response.ok) {
    throw new Error(`Failed to load session threads (${response.status})`);
  }

  return (await response.json()) as SessionThreadSummary[];
}

async function fetchSessionSnapshot(baseUrl: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/snapshot`);
  if (!response.ok) {
    throw new Error(`Failed to load session snapshot (${response.status})`);
  }

  return (await response.json()) as SessionSnapshot;
}

export function useShellConversation(): ShellConversationState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const lastEventSeqRef = useRef(previewSessionSnapshot.lastEventSeq);
  const deviceIdRef = useRef(getStableDesktopSessionDeviceId());
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(previewSessionSnapshot);
  const [threads, setThreads] = useState<SessionThreadSummary[]>(previewSessionThreads);
  const [activeSessionId, setActiveSessionId] = useState(getStoredActiveSessionId());
  const [status, setStatus] = useState<ShellConversationState["status"]>("loading");
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    rememberActiveSessionId(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl: baseUrl } = await bridge.getAppMeta();
        const nextThreads = await fetchSessionThreads(baseUrl);
        const preferredSessionId = nextThreads.find((thread) => thread.id === getStoredActiveSessionId())?.id;
        const fallbackSessionId = nextThreads[0]?.id ?? localDraftSessionId;

        if (!cancelled) {
          setDaemonBaseUrl(baseUrl);
          setThreads(nextThreads);
          setActiveSessionId(preferredSessionId ?? fallbackSessionId);
          if (nextThreads.length === 0) {
            setSnapshot((current) => createLocalDraftSnapshot(current));
            lastEventSeqRef.current = 0;
            setStatus("ready");
          }
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load shell session");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!daemonBaseUrl || !activeSessionId || activeSessionId === localDraftSessionId) {
      if (activeSessionId === localDraftSessionId) {
        setStatus("ready");
      }
      return;
    }

    const currentBaseUrl = daemonBaseUrl;
    const currentSessionId = activeSessionId;
    let cancelled = false;
    setStatus("loading");

    async function loadSnapshot() {
      try {
        const nextSnapshot = await fetchSessionSnapshot(currentBaseUrl, currentSessionId);
        if (!cancelled) {
          lastEventSeqRef.current = nextSnapshot.lastEventSeq;
          setSnapshot(nextSnapshot);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Failed to load shell session");
        }
      }
    }

    void loadSnapshot();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, daemonBaseUrl]);

  useEffect(() => {
    if (snapshot.session.id === localDraftSessionId || snapshot.messages.length === 0) {
      return;
    }

    setThreads((current) => upsertThread(current, buildThreadFromSnapshot(snapshot)));
  }, [snapshot]);

  useEffect(() => {
    if (!daemonBaseUrl || !activeSessionId || activeSessionId === localDraftSessionId) {
      return;
    }

    const currentBaseUrl = daemonBaseUrl;
    const currentSessionId = activeSessionId;
    let disposed = false;
    let retryTimer: number | null = null;
    let source: EventSource | null = null;
    let reconciling = false;
    let reconcileQueued = false;

    const refreshThreads = async () => {
      try {
        const nextThreads = await fetchSessionThreads(currentBaseUrl);
        if (!disposed && nextThreads.length > 0) {
          setThreads(nextThreads);
        }
      } catch {
        // Keep the current thread list when a background refresh fails.
      }
    };

    const reconcileSnapshot = async () => {
      if (reconciling) {
        reconcileQueued = true;
        return;
      }

      reconciling = true;

      do {
        reconcileQueued = false;

        try {
          const nextSnapshot = await fetchSessionSnapshot(currentBaseUrl, currentSessionId);
          if (!disposed) {
            lastEventSeqRef.current = Math.max(lastEventSeqRef.current, nextSnapshot.lastEventSeq);
            setSnapshot(nextSnapshot);
            setStatus("ready");
            setError(undefined);
          }
        } catch {
          // Keep the live stream state when a background reconciliation fails.
        }
      } while (!disposed && reconcileQueued);

      reconciling = false;
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      source = new EventSource(`${currentBaseUrl}/api/session/${currentSessionId}/stream?since=${lastEventSeqRef.current}`);

      source.onopen = () => {
        if (!disposed) {
          void reconcileSnapshot();
        }
      };

      source.addEventListener("session", (event) => {
        const messageEvent = event as MessageEvent<string>;
        const sessionEvent = JSON.parse(messageEvent.data) as SessionEvent;
        lastEventSeqRef.current = Math.max(lastEventSeqRef.current, sessionEvent.seq);

        setSnapshot((current) => {
          return applySessionEvent(current, sessionEvent);
        });

        if (
          sessionEvent.type === "message.created" ||
          sessionEvent.type === "message.acked"
        ) {
          void refreshThreads();
        }
      });

      source.onerror = () => {
        source?.close();
        source = null;

        if (!disposed) {
          retryTimer = window.setTimeout(connect, streamRetryMs);
        }
      };
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void reconcileSnapshot();
      }
    };

    const handleWindowFocus = () => {
      void reconcileSnapshot();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      source?.close();
    };
  }, [activeSessionId, daemonBaseUrl]);

  function selectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      return;
    }

    setActiveSessionId(sessionId);
  }

  async function createSession(): Promise<CreateSessionResult> {
    if (activeSessionId === localDraftSessionId) {
      return {
        ok: true,
        sessionId: activeSessionId,
      };
    }

    setSnapshot((current) => createLocalDraftSnapshot(current));
    lastEventSeqRef.current = 0;
    setStatus("ready");
    setError(undefined);
    setActiveSessionId(localDraftSessionId);
    return {
      ok: true,
      sessionId: localDraftSessionId,
    };
  }

  async function sendMessage(content: string): Promise<SendResult> {
    if (!daemonBaseUrl) {
      return {
        ok: false,
        error: "本地 daemon 还没连上。",
      };
    }

    setPending(true);

    try {
      let targetSessionId = activeSessionId;
      let createdThread: SessionThreadSummary | null = null;

      if (activeSessionId === localDraftSessionId) {
        const createResponse = await fetch(`${daemonBaseUrl}/api/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });

        const createdPayload = (await createResponse.json()) as SessionThreadSummary & { error?: string };
        if (!createResponse.ok) {
          return {
            ok: false,
            error: createdPayload.error ?? "新建线程失败",
          };
        }

        targetSessionId = createdPayload.id;
        createdThread = createdPayload;
      }

      const response = await fetch(`${daemonBaseUrl}/api/session/${targetSessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: `${deviceIdRef.current}-${Date.now()}`,
          content,
          deviceId: deviceIdRef.current,
          deviceType: "desktop",
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        message?: SessionMessage;
        runtimePresence?: RuntimePresence;
      };

      if (!response.ok) {
        return {
          ok: false,
          error: payload.error ?? "发送失败",
        };
      }

      if (createdThread) {
        setSnapshot((current) => createEmptySnapshotFromThread(createdThread as SessionThreadSummary, current));
        lastEventSeqRef.current = 0;
        setStatus("ready");
        setError(undefined);
        setActiveSessionId(createdThread.id);
      }

      if (payload.message) {
        setSnapshot((current) => ({
          ...current,
          session: {
            ...current.session,
            id: targetSessionId,
            updatedAt: payload.message?.createdAt ?? current.session.updatedAt,
          },
          messages: upsertMessage(current.messages, payload.message as SessionMessage),
          runtimePresence: payload.runtimePresence ?? current.runtimePresence,
        }));
      }

      try {
        const nextThreads = await fetchSessionThreads(daemonBaseUrl);
        if (nextThreads.length > 0) {
          setThreads(nextThreads);
        }
      } catch {
        // Keep the locally updated thread list if the background refresh fails.
      }

      return { ok: true };
    } catch (sendError) {
      return {
        ok: false,
        error: sendError instanceof Error ? sendError.message : "发送失败",
      };
    } finally {
      setPending(false);
    }
  }

  const latestReply = [...snapshot.messages].reverse().find((message) => message.role !== "user") ?? null;
  const latestJob = snapshot.jobs.find((job) => job.kind === "provider-completion") ?? null;
  const latestArtifact = snapshot.artifacts[0] ?? null;
  const sessionTitle =
    (activeSessionId === localDraftSessionId ? null : threads.find((thread) => thread.id === activeSessionId)?.title) ??
    snapshot.session.title;

  return {
    status,
    sessionId: activeSessionId,
    sessionTitle,
    threads,
    messages: snapshot.messages,
    runtimePresence: snapshot.runtimePresence,
    latestReply,
    latestJob,
    latestArtifact,
    pending,
    error,
    selectSession,
    createSession,
    sendMessage,
  };
}
