import {
  previewSessionSnapshot,
  primarySessionId,
  type Attachment,
  type DevicePresence,
  type JobRunDetail,
  type RuntimePresence,
  type SessionEvent,
  type SessionMessage,
  type SessionSnapshot,
  type StudyArtifact,
} from "@aliceloop/runtime-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDesktopBridge } from "../../platform/desktopBridge";

const HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_RETRY_MS = 2_000;
const mobileDeviceStorageKey = "aliceloop-companion-device-id";

interface MutationResult {
  ok: boolean;
  error?: string;
}

interface UploadResult extends MutationResult {
  attachment?: Attachment;
}

export interface CompanionState {
  status: "loading" | "ready" | "error";
  snapshot: SessionSnapshot;
  streamStatus: "connecting" | "live" | "reconnecting";
  daemonBaseUrl: string | null;
  pendingMessage: boolean;
  pendingUpload: boolean;
  error?: string;
  sendMessage(input: { content: string; attachmentIds: string[] }): Promise<MutationResult>;
  uploadAttachment(file: File): Promise<UploadResult>;
}

function getStableDeviceId(storageKey: string, prefix: string) {
  if (typeof window === "undefined") {
    return `${prefix}-server`;
  }

  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const next = `${prefix}-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, next);
  return next;
}

function upsertMessage(messages: SessionMessage[], message: SessionMessage) {
  const next = messages.filter((item) => item.id !== message.id && item.clientMessageId !== message.clientMessageId);
  next.push(message);
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return next;
}

function upsertAttachment(attachments: Attachment[], attachment: Attachment) {
  const next = attachments.filter((item) => item.id !== attachment.id);
  next.push(attachment);
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
      const payload = event.payload as {
        devices?: DevicePresence[];
        runtimePresence?: RuntimePresence;
      };

      return {
        ...snapshot,
        devices: payload.devices ?? snapshot.devices,
        runtimePresence: payload.runtimePresence ?? snapshot.runtimePresence,
      };
    }
    default:
      return snapshot;
  }
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

export function useCompanionData(): CompanionState {
  const bridge = useMemo(() => getDesktopBridge(), []);
  const lastEventSeqRef = useRef(previewSessionSnapshot.lastEventSeq);
  const deviceIdRef = useRef(getStableDeviceId(mobileDeviceStorageKey, "mobile"));
  const [daemonBaseUrl, setDaemonBaseUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<CompanionState["status"]>("loading");
  const [streamStatus, setStreamStatus] = useState<CompanionState["streamStatus"]>("connecting");
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(previewSessionSnapshot);
  const [error, setError] = useState<string>();
  const [pendingMessage, setPendingMessage] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { daemonBaseUrl: baseUrl } = await bridge.getAppMeta();
        const response = await fetch(`${baseUrl}/api/session/${primarySessionId}/snapshot`);

        if (!response.ok) {
          throw new Error(`Failed to load companion snapshot (${response.status})`);
        }

        const nextSnapshot = (await response.json()) as SessionSnapshot;
        if (!cancelled) {
          lastEventSeqRef.current = nextSnapshot.lastEventSeq;
          setDaemonBaseUrl(baseUrl);
          setSnapshot(nextSnapshot);
          setStatus("ready");
          setError(undefined);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("error");
          setError(loadError instanceof Error ? loadError.message : "Unknown companion error");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!daemonBaseUrl) {
      return;
    }

    let isDisposed = false;
    let retryTimer: number | null = null;
    let source: EventSource | null = null;

    const connect = () => {
      if (isDisposed) {
        return;
      }

      setStreamStatus((current) => (current === "live" ? "reconnecting" : "connecting"));
      source = new EventSource(`${daemonBaseUrl}/api/session/${primarySessionId}/stream?since=${lastEventSeqRef.current}`);

      source.onopen = () => {
        if (!isDisposed) {
          setStreamStatus("live");
        }
      };

      source.addEventListener("session", (event) => {
        const messageEvent = event as MessageEvent<string>;
        const sessionEvent = JSON.parse(messageEvent.data) as SessionEvent;
        lastEventSeqRef.current = Math.max(lastEventSeqRef.current, sessionEvent.seq);
        setSnapshot((current) => applySessionEvent(current, sessionEvent));
      });

      source.onerror = () => {
        source?.close();
        source = null;

        if (!isDisposed) {
          setStreamStatus("reconnecting");
          retryTimer = window.setTimeout(connect, STREAM_RETRY_MS);
        }
      };
    };

    connect();

    return () => {
      isDisposed = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      source?.close();
    };
  }, [daemonBaseUrl]);

  useEffect(() => {
    if (!daemonBaseUrl) {
      return;
    }

    const heartbeat = async () => {
      try {
        const response = await fetch(`${daemonBaseUrl}/api/runtime/presence/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId: deviceIdRef.current,
            deviceType: "mobile",
            label: "Aliceloop Companion",
            sessionId: primarySessionId,
          }),
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as {
          devices?: DevicePresence[];
          runtimePresence?: RuntimePresence;
        };

        setSnapshot((current) => ({
          ...current,
          devices: payload.devices ?? current.devices,
          runtimePresence: payload.runtimePresence ?? current.runtimePresence,
        }));
      } catch {
        setStreamStatus((current) => (current === "live" ? current : "reconnecting"));
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => {
      void heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [daemonBaseUrl]);

  async function sendMessage(input: { content: string; attachmentIds: string[] }): Promise<MutationResult> {
    if (!daemonBaseUrl) {
      return { ok: false, error: "本地 daemon 尚未连接" };
    }

    setPendingMessage(true);

    try {
      const response = await fetch(`${daemonBaseUrl}/api/session/${primarySessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: `${deviceIdRef.current}-${Date.now()}`,
          content: input.content,
          attachmentIds: input.attachmentIds,
          role: "user",
          deviceId: deviceIdRef.current,
          deviceType: "mobile",
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
          error: payload.error === "runtime_offline" ? "桌面 runtime 当前离线，消息先保留在草稿里。" : payload.error ?? "发送失败",
        };
      }

      if (payload.message) {
        setSnapshot((current) => ({
          ...current,
          messages: upsertMessage(current.messages, payload.message as SessionMessage),
        }));
      }

      return { ok: true };
    } catch (sendError) {
      return {
        ok: false,
        error: sendError instanceof Error ? sendError.message : "发送失败",
      };
    } finally {
      setPendingMessage(false);
    }
  }

  async function uploadAttachment(file: File): Promise<UploadResult> {
    if (!daemonBaseUrl) {
      return { ok: false, error: "本地 daemon 尚未连接" };
    }

    setPendingUpload(true);

    try {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch(`${daemonBaseUrl}/api/session/${primarySessionId}/attachments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64,
          deviceId: deviceIdRef.current,
          deviceType: "mobile",
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
          error: payload.error === "runtime_offline" ? "桌面 runtime 当前离线，暂时不能上传附件。" : payload.error ?? "上传失败",
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

  return {
    status,
    snapshot,
    streamStatus,
    daemonBaseUrl,
    pendingMessage,
    pendingUpload,
    error,
    sendMessage,
    uploadAttachment,
  };
}
