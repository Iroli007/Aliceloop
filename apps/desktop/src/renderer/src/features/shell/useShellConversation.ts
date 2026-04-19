import {
  applyToolWorkflowEvent,
  isToolWorkflowTerminalStatus,
  type Attachment,
  previewSessionSnapshot,
  primarySessionId,
  type JobRunDetail,
  type RuntimePresence,
  type SessionEvent,
  type SessionMessage,
  type SessionSnapshot,
  type SessionThreadSummary,
  type StudyArtifact,
  type ToolApproval,
  type ToolCallStatus,
  type ToolWorkflowEntry,
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

interface UploadResult extends SendResult {
  attachment?: Attachment;
}

interface FolderUploadPayload {
  folderName: string;
  files: Array<{
    relativePath: string;
    mimeType: string;
    contentBase64: string;
  }>;
}

export interface ShellConversationState {
  status: "loading" | "ready" | "error";
  daemonBaseUrl: string | null;
  sessionId: string;
  sessionTitle: string;
  threads: SessionThreadSummary[];
  messages: SessionMessage[];
  runtimePresence: RuntimePresence;
  latestReply: SessionMessage | null;
  latestJob: JobRunDetail | null;
  latestArtifact: StudyArtifact | null;
  toolWorkflowEntries: ToolWorkflowEntry[];
  sessionEvents: SessionEvent[];
  pendingToolApprovals: ToolApproval[];
  resolvedToolApprovals: ToolApproval[];
  pending: boolean;
  pendingUpload: boolean;
  currentToolName: string | null;
  thinkingSteps: string[];
  isResponding: boolean;
  isAwaitingToolApproval: boolean;
  stoppingResponse: boolean;
  resolvingToolApprovalId: string | null;
  error?: string;
  selectSession(sessionId: string): void;
  createSession(): Promise<CreateSessionResult>;
  sendMessage(content: string, attachmentIds?: string[]): Promise<SendResult>;
  uploadAttachment(file: File): Promise<UploadResult>;
  uploadFolder(files: File[]): Promise<UploadResult>;
  uploadPreparedAttachment(input: {
    fileName: string;
    mimeType: string;
    contentBase64: string;
    originalPath?: string;
  }): Promise<UploadResult>;
  uploadPreparedFolder(input: FolderUploadPayload): Promise<UploadResult>;
  stopResponse(): Promise<SendResult>;
  approveToolApproval(approvalId: string): Promise<SendResult>;
  rejectToolApproval(approvalId: string): Promise<SendResult>;
}

interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status?: ToolCallStatus;
  backend?: string | null;
}
export type { ToolWorkflowEntry };

function buildActiveToolCalls(toolWorkflowEntries: ToolWorkflowEntry[]): ActiveToolCall[] {
  return toolWorkflowEntries
    .filter((entry) => !isToolWorkflowTerminalStatus(entry.status))
    .map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      status: entry.status,
      backend: entry.backend,
    }));
}

function formatThinkingStep(toolName: string, backend?: string | null) {
  return backend ? `Thinking · ${toolName} · ${backend}` : `Thinking · ${toolName}`;
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

function upsertAttachment(attachments: Attachment[], attachment: Attachment) {
  const next = attachments.filter((item) => item.id !== attachment.id);
  next.push(attachment);
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return next;
}

function upsertToolApproval(approvals: ToolApproval[], approval: ToolApproval) {
  const next = approvals.filter((item) => item.id !== approval.id);
  if (approval.status === "pending") {
    next.push(approval);
  }
  next.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  return next;
}

function upsertResolvedToolApproval(approvals: ToolApproval[], approval: ToolApproval) {
  const next = approvals.filter((item) => item.id !== approval.id);
  if (approval.status !== "pending") {
    next.push(approval);
  }
  next.sort((left, right) => {
    const leftTime = left.resolvedAt ?? left.requestedAt;
    const rightTime = right.resolvedAt ?? right.requestedAt;
    return leftTime.localeCompare(rightTime);
  });
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

function isProviderCompletionActive(job: JobRunDetail | null) {
  return job?.status === "running" || job?.status === "queued";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

async function buildFolderUploadPayload(files: File[]): Promise<FolderUploadPayload | null> {
  if (files.length === 0) {
    return null;
  }

  const firstRelativePath = files[0].webkitRelativePath;
  if (!firstRelativePath) {
    return null;
  }

  const folderName = firstRelativePath.split("/").filter(Boolean)[0] ?? "folder";
  const payloadFiles: FolderUploadPayload["files"] = [];

  for (const file of files) {
    const relativePath = file.webkitRelativePath;
    if (!relativePath) {
      return null;
    }

    const segments = relativePath.split("/").filter(Boolean);
    const relativeSegments = segments[0] === folderName ? segments.slice(1) : segments;
    const normalizedRelativePath = relativeSegments.join("/");
    if (!normalizedRelativePath) {
      continue;
    }

    payloadFiles.push({
      relativePath: normalizedRelativePath,
      mimeType: file.type || "application/octet-stream",
      contentBase64: await fileToBase64(file),
    });
  }

  if (payloadFiles.length === 0) {
    return null;
  }

  return {
    folderName,
    files: payloadFiles,
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
    toolWorkflowEntries: [],
    pendingToolApprovals: [],
    resolvedToolApprovals: [],
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
    toolWorkflowEntries: [],
    pendingToolApprovals: [],
    resolvedToolApprovals: [],
    jobs: [],
    artifacts: [],
    lastEventSeq: 0,
  };
}

function applySessionEvent(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  switch (event.type) {
    case "tool.call.started":
    case "tool.call.completed":
    case "tool.state.change":
      return {
        ...snapshot,
        toolWorkflowEntries: applyToolWorkflowEvent(snapshot.toolWorkflowEntries, event),
      };
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
    case "attachment.ready": {
      const attachment = (event.payload as { attachment?: Attachment }).attachment;
      if (!attachment) {
        return snapshot;
      }

      return {
        ...snapshot,
        attachments: upsertAttachment(snapshot.attachments, attachment),
      };
    }
    case "tool.approval.requested":
    case "tool.approval.resolved": {
      const approval = (event.payload as { approval?: ToolApproval }).approval;
      if (!approval) {
        return snapshot;
      }

      return {
        ...snapshot,
        pendingToolApprovals: upsertToolApproval(snapshot.pendingToolApprovals, approval),
        resolvedToolApprovals:
          event.type === "tool.approval.resolved"
            ? upsertResolvedToolApproval(snapshot.resolvedToolApprovals, approval)
            : snapshot.resolvedToolApprovals,
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

async function fetchSessionEvents(baseUrl: string, sessionId: string, since = 0) {
  const params = new URLSearchParams();
  if (since > 0) {
    params.set("since", String(since));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/events${suffix}`);
  if (!response.ok) {
    throw new Error(`Failed to load session events (${response.status})`);
  }

  return (await response.json()) as SessionEvent[];
}

export function useShellConversation(): ShellConversationState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const initialSnapshot = createLocalDraftSnapshot(previewSessionSnapshot);
  const lastEventSeqRef = useRef(0);
  const deviceIdRef = useRef(getStableDesktopSessionDeviceId());
  const activeSessionIdRef = useRef(getStoredActiveSessionId());
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(initialSnapshot);
  const [threads, setThreads] = useState<SessionThreadSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(getStoredActiveSessionId());
  const [status, setStatus] = useState<ShellConversationState["status"]>("loading");
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(false);
  const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([]);
  const [stoppingResponse, setStoppingResponse] = useState(false);
  const [resolvingToolApprovalId, setResolvingToolApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
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
            setSessionEvents([]);
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
        setSessionEvents([]);
        setStatus("ready");
      }
      return;
    }

    const currentBaseUrl = daemonBaseUrl;
    const currentSessionId = activeSessionId;
    let cancelled = false;
    setStatus("loading");
    setSessionEvents([]);

    async function loadSnapshot() {
      try {
        const [nextSnapshot, nextEvents] = await Promise.all([
          fetchSessionSnapshot(currentBaseUrl, currentSessionId),
          fetchSessionEvents(currentBaseUrl, currentSessionId),
        ]);
        if (!cancelled && activeSessionIdRef.current === currentSessionId) {
          lastEventSeqRef.current = nextSnapshot.lastEventSeq;
          setSnapshot(nextSnapshot);
          setSessionEvents(nextEvents);
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
          if (!disposed && activeSessionIdRef.current === currentSessionId) {
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
        if (disposed || activeSessionIdRef.current !== currentSessionId || sessionEvent.sessionId !== currentSessionId) {
          return;
        }
        lastEventSeqRef.current = Math.max(lastEventSeqRef.current, sessionEvent.seq);
        setSessionEvents((current) => [...current, sessionEvent]);

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

    console.log('[selectSession] Switching to:', sessionId, 'Clearing state');
    activeSessionIdRef.current = sessionId;
    rememberActiveSessionId(sessionId);
    setStatus("loading");
    setSnapshot((current) => {
      if (sessionId === localDraftSessionId) {
        return createLocalDraftSnapshot(current);
      }
      return current;
    });
    setSessionEvents([]);
    lastEventSeqRef.current = 0;
    setActiveSessionId(sessionId);
  }

  function activateCreatedThread(createdThread: SessionThreadSummary) {
    activeSessionIdRef.current = createdThread.id;
    rememberActiveSessionId(createdThread.id);
    setSnapshot((current) => createEmptySnapshotFromThread(createdThread, current));
    setSessionEvents([]);
    lastEventSeqRef.current = 0;
    setStatus("ready");
    setError(undefined);
    setActiveSessionId(createdThread.id);
  }

  async function refreshThreadsSafely(baseUrl: string) {
    try {
      const nextThreads = await fetchSessionThreads(baseUrl);
      if (nextThreads.length > 0) {
        setThreads(nextThreads);
      }
    } catch {
      // Keep the locally updated thread list if the background refresh fails.
    }
  }

  async function ensureTargetSession(baseUrl: string): Promise<
    | { ok: true; sessionId: string }
    | { ok: false; error: string }
  > {
    if (activeSessionId !== localDraftSessionId) {
      return {
        ok: true,
        sessionId: activeSessionId,
      };
    }

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
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

    activateCreatedThread(createdPayload);
    void refreshThreadsSafely(baseUrl);

    return {
      ok: true,
      sessionId: createdPayload.id,
    };
  }

  async function createSession(): Promise<CreateSessionResult> {
    activeSessionIdRef.current = localDraftSessionId;
    rememberActiveSessionId(localDraftSessionId);
    setSnapshot((current) => createLocalDraftSnapshot(current));
    setSessionEvents([]);
    lastEventSeqRef.current = 0;
    setStatus("ready");
    setError(undefined);
    setActiveSessionId(localDraftSessionId);
    return {
      ok: true,
      sessionId: localDraftSessionId,
    };
  }

  async function sendMessage(content: string, attachmentIds: string[] = []): Promise<SendResult> {
    if (!daemonBaseUrl) {
      return {
        ok: false,
        error: "本地 daemon 还没连上。",
      };
    }

    setPending(true);

    try {
      const ensuredSession = await ensureTargetSession(daemonBaseUrl);
      if (!ensuredSession.ok) {
        return {
          ok: false,
          error: ensuredSession.error,
        };
      }

      const targetSessionId = ensuredSession.sessionId;

      const response = await fetch(`${daemonBaseUrl}/api/session/${targetSessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: `${deviceIdRef.current}-${Date.now()}`,
          content,
          attachmentIds,
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
        if (payload.runtimePresence) {
          setSnapshot((current) => ({
            ...current,
            runtimePresence: payload.runtimePresence ?? current.runtimePresence,
          }));
        }

        return {
          ok: false,
          error: payload.error ?? "发送失败",
        };
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

      await refreshThreadsSafely(daemonBaseUrl);

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

  async function uploadPreparedAttachment(input: {
    fileName: string;
    mimeType: string;
    contentBase64: string;
    originalPath?: string;
  }): Promise<UploadResult> {
    if (!daemonBaseUrl) {
      return {
        ok: false,
        error: "本地 daemon 还没连上。",
      };
    }

    setPendingUpload(true);

    try {
      const ensuredSession = await ensureTargetSession(daemonBaseUrl);
      if (!ensuredSession.ok) {
        return {
          ok: false,
          error: ensuredSession.error,
        };
      }

      const response = await fetch(`${daemonBaseUrl}/api/session/${ensuredSession.sessionId}/attachments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: input.fileName,
          mimeType: input.mimeType,
          contentBase64: input.contentBase64,
          originalPath: input.originalPath,
          deviceId: deviceIdRef.current,
          deviceType: "desktop",
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        attachment?: Attachment;
        jobs?: JobRunDetail[];
        runtimePresence?: RuntimePresence;
      };

      if (!response.ok) {
        if (payload.runtimePresence) {
          setSnapshot((current) => ({
            ...current,
            runtimePresence: payload.runtimePresence ?? current.runtimePresence,
          }));
        }

        return {
          ok: false,
          error: payload.error ?? "上传失败",
        };
      }

      if (payload.attachment) {
        setSnapshot((current) => {
          let nextJobs = current.jobs;
          for (const job of payload.jobs ?? []) {
            nextJobs = upsertJob(nextJobs, job);
          }

          return {
            ...current,
            attachments: upsertAttachment(current.attachments, payload.attachment as Attachment),
            jobs: nextJobs,
          };
        });
      }

      await refreshThreadsSafely(daemonBaseUrl);

      return {
        ok: true,
        attachment: payload.attachment as Attachment | undefined,
      };
    } catch (uploadError) {
      return {
        ok: false,
        error: uploadError instanceof Error ? uploadError.message : "上传失败",
      };
    } finally {
      setPendingUpload(false);
    }
  }

  async function uploadAttachment(file: File): Promise<UploadResult> {
    const contentBase64 = await fileToBase64(file);
    return uploadPreparedAttachment({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      contentBase64,
    });
  }

  async function uploadPreparedFolder(input: FolderUploadPayload): Promise<UploadResult> {
    if (!daemonBaseUrl) {
      return {
        ok: false,
        error: "本地 daemon 还没连上。",
      };
    }

    setPendingUpload(true);

    try {
      const ensuredSession = await ensureTargetSession(daemonBaseUrl);
      if (!ensuredSession.ok) {
        return {
          ok: false,
          error: ensuredSession.error,
        };
      }

      const response = await fetch(`${daemonBaseUrl}/api/session/${ensuredSession.sessionId}/attachment-folders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folderName: input.folderName,
          files: input.files,
          deviceId: deviceIdRef.current,
          deviceType: "desktop",
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        attachment?: Attachment;
        jobs?: JobRunDetail[];
        runtimePresence?: RuntimePresence;
      };

      if (!response.ok) {
        if (payload.runtimePresence) {
          setSnapshot((current) => ({
            ...current,
            runtimePresence: payload.runtimePresence ?? current.runtimePresence,
          }));
        }

        return {
          ok: false,
          error: payload.error ?? "文件夹上传失败",
        };
      }

      if (payload.attachment) {
        setSnapshot((current) => {
          let nextJobs = current.jobs;
          for (const job of payload.jobs ?? []) {
            nextJobs = upsertJob(nextJobs, job);
          }

          return {
            ...current,
            attachments: upsertAttachment(current.attachments, payload.attachment as Attachment),
            jobs: nextJobs,
          };
        });
      }

      await refreshThreadsSafely(daemonBaseUrl);

      return {
        ok: true,
        attachment: payload.attachment as Attachment | undefined,
      };
    } catch (uploadError) {
      return {
        ok: false,
        error: uploadError instanceof Error ? uploadError.message : "文件夹上传失败",
      };
    } finally {
      setPendingUpload(false);
    }
  }

  async function uploadFolder(files: File[]): Promise<UploadResult> {
    const folderPayload = await buildFolderUploadPayload(files);
    if (!folderPayload) {
      return {
        ok: false,
        error: "当前环境没有返回有效的文件夹层级，暂时无法上传文件夹。",
      };
    }

    return uploadPreparedFolder(folderPayload);
  }

  async function stopResponse(): Promise<SendResult> {
    if (!daemonBaseUrl || activeSessionId === localDraftSessionId) {
      return {
        ok: false,
        error: "当前没有可停止输出的会话。",
      };
    }

    const currentLatestJob = snapshot.jobs.find((job) => job.kind === "provider-completion") ?? null;
    if (!isProviderCompletionActive(currentLatestJob)) {
      return {
        ok: false,
        error: "当前没有正在输出的 agent。",
      };
    }

    setStoppingResponse(true);

    try {
      const response = await fetch(`${daemonBaseUrl}/api/session/${activeSessionId}/abort`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        aborted?: boolean;
        error?: string;
      };

      if (!response.ok) {
        setStoppingResponse(false);
        return {
          ok: false,
          error: payload.error ?? "停止失败",
        };
      }

      if (!payload.aborted) {
        setStoppingResponse(false);
        return {
          ok: false,
          error: "当前没有正在输出的 agent。",
        };
      }

      return { ok: true };
    } catch (stopError) {
      setStoppingResponse(false);
      return {
        ok: false,
        error: stopError instanceof Error ? stopError.message : "停止失败",
      };
    }
  }

  async function resolveToolApproval(approvalId: string, action: "approve" | "reject"): Promise<SendResult> {
    if (!daemonBaseUrl || activeSessionId === localDraftSessionId) {
      return {
        ok: false,
        error: "当前没有可处理命令审批的会话。",
      };
    }

    setResolvingToolApprovalId(approvalId);

    try {
      const response = await fetch(`${daemonBaseUrl}/api/session/${activeSessionId}/tool-approvals/${approvalId}/${action}`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        error?: string;
        approval?: ToolApproval;
      };

      if (!response.ok) {
        return {
          ok: false,
          error: payload.error ?? "命令审批失败",
        };
      }

      if (payload.approval) {
        setSnapshot((current) => ({
          ...current,
          pendingToolApprovals: upsertToolApproval(current.pendingToolApprovals, payload.approval as ToolApproval),
        }));
      }

      return { ok: true };
    } catch (approvalError) {
      return {
        ok: false,
        error: approvalError instanceof Error ? approvalError.message : "命令审批失败",
      };
    } finally {
      setResolvingToolApprovalId(null);
    }
  }

  const activeToolCalls = useMemo(() => buildActiveToolCalls(snapshot.toolWorkflowEntries), [snapshot.toolWorkflowEntries]);
  const latestReply = [...snapshot.messages].reverse().find((message) => message.role !== "user") ?? null;
  const latestJob = snapshot.jobs.find((job) => job.kind === "provider-completion") ?? null;
  const latestArtifact = snapshot.artifacts[0] ?? null;
  const isAwaitingToolApproval = snapshot.pendingToolApprovals.length > 0;
  const currentToolName = activeToolCalls.at(-1)?.toolName ?? snapshot.pendingToolApprovals[0]?.toolName ?? null;
  const thinkingSteps = activeToolCalls.map((toolCall) => formatThinkingStep(toolCall.toolName, toolCall.backend));
  const isResponding = isProviderCompletionActive(latestJob) && !isAwaitingToolApproval;
  const sessionTitle =
    (activeSessionId === localDraftSessionId ? null : threads.find((thread) => thread.id === activeSessionId)?.title) ??
    snapshot.session.title;

  useEffect(() => {
    if (!isResponding) {
      setStoppingResponse(false);
    }
  }, [isResponding]);

  return {
    status,
    daemonBaseUrl,
    sessionId: activeSessionId,
    sessionTitle,
    threads,
    messages: snapshot.messages,
    runtimePresence: snapshot.runtimePresence,
    latestReply,
    latestJob,
    latestArtifact,
    toolWorkflowEntries: snapshot.toolWorkflowEntries,
    sessionEvents,
    pendingToolApprovals: snapshot.pendingToolApprovals,
    resolvedToolApprovals: snapshot.resolvedToolApprovals,
    pending,
    pendingUpload,
    currentToolName,
    thinkingSteps,
    isResponding,
    isAwaitingToolApproval,
    stoppingResponse,
    resolvingToolApprovalId,
    error,
    selectSession,
    createSession,
    sendMessage,
    uploadAttachment,
    uploadFolder,
    uploadPreparedAttachment,
    uploadPreparedFolder,
    stopResponse,
    approveToolApproval: (approvalId: string) => resolveToolApproval(approvalId, "approve"),
    rejectToolApproval: (approvalId: string) => resolveToolApproval(approvalId, "reject"),
  };
}
