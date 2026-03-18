import type { Attachment } from "@aliceloop/runtime-core";
import { useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { CompanionState } from "./useCompanionData";

interface CompanionLayoutProps {
  state: CompanionState;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(byteSize: number) {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(1)} KB`;
  }

  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function mergeAttachments(current: Attachment[], next: Attachment[]) {
  const merged = [...current];

  for (const attachment of next) {
    if (!merged.find((item) => item.id === attachment.id)) {
      merged.push(attachment);
    }
  }

  return merged;
}

function getArtifactBody(body: string | undefined, summary: string) {
  const normalizedBody = body?.trim();
  if (!normalizedBody) {
    return summary;
  }

  const normalizedSummary = summary.trim().replace(/…$/, "");
  if (normalizedSummary && normalizedBody.replace(/\s+/g, " ").startsWith(normalizedSummary.replace(/\s+/g, " "))) {
    return null;
  }

  return normalizedBody;
}

export function CompanionLayout({ state }: CompanionLayoutProps) {
  const [draft, setDraft] = useState("");
  const [queuedAttachments, setQueuedAttachments] = useState<Attachment[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);

  const onlineDevices = state.snapshot.devices.filter((device) => device.status === "online");
  const latestJobs = state.snapshot.jobs.slice(0, 3);
  const runtimeOffline = !state.snapshot.runtimePresence.online;

  async function submitDraft() {
    if (!draft.trim() && queuedAttachments.length === 0) {
      return;
    }

    setComposerError(null);
    const result = await state.sendMessage({
      content: draft.trim(),
      attachmentIds: queuedAttachments.map((attachment) => attachment.id),
    });

    if (!result.ok) {
      setComposerError(result.error ?? "发送失败");
      return;
    }

    setDraft("");
    setQueuedAttachments([]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void submitDraft();
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) {
      return;
    }

    setComposerError(null);
    const uploaded: Attachment[] = [];

    for (const file of files) {
      const result = await state.uploadAttachment(file);
      if (!result.ok) {
        setComposerError(result.error ?? "上传失败");
        continue;
      }

      if (result.attachment) {
        uploaded.push(result.attachment);
      }
    }

    if (uploaded.length > 0) {
      setQueuedAttachments((current) => mergeAttachments(current, uploaded));
    }

    input.value = "";
  }

  return (
    <div className="companion">
      <header className="companion__header">
        <div>
          <div className="companion__eyebrow">Aliceloop Companion</div>
          <h1>{state.snapshot.session.title}</h1>
        </div>
        <div className={`companion__status-chip${runtimeOffline ? " companion__status-chip--offline" : ""}`}>
          {runtimeOffline ? "runtime offline" : "runtime online"}
        </div>
      </header>

      <section className="companion__summary">
        <div className="companion__summary-card">
          <span>流状态</span>
          <strong>{state.streamStatus === "live" ? "实时同步中" : state.streamStatus === "connecting" ? "正在连接" : "重连中"}</strong>
        </div>
        <div className="companion__summary-card">
          <span>在线设备</span>
          <strong>{onlineDevices.length} 台</strong>
        </div>
        <div className="companion__summary-card">
          <span>最近任务</span>
          <strong>{latestJobs[0]?.title ?? "暂无任务"}</strong>
        </div>
      </section>

      <section className="companion__panel">
        <div className="companion__panel-header">
          <h2>会话消息</h2>
          <span>{state.snapshot.messages.length} 条</span>
        </div>
        <div className="companion__messages">
          {state.snapshot.messages.map((message) => (
            <article key={message.id} className={`companion__message companion__message--${message.role}`}>
              <div className="companion__message-meta">
                <span>{message.role === "user" ? "你" : message.role === "assistant" ? "Aliceloop" : "System"}</span>
                <span>{formatTime(message.createdAt)}</span>
              </div>
              <p>{message.content}</p>
              {message.attachments.length > 0 ? (
                <div className="companion__attachment-list">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id} className="companion__attachment-chip">
                      {attachment.fileName}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="companion__split">
        <div className="companion__panel">
          <div className="companion__panel-header">
            <h2>最近工件</h2>
            <span>{state.snapshot.artifacts.length}</span>
          </div>
          <div className="companion__artifact-list">
            {state.snapshot.artifacts.map((artifact) => (
              <article key={artifact.id} className="companion__artifact-card">
                <strong>{artifact.title}</strong>
                <p>{artifact.summary}</p>
                {getArtifactBody(artifact.body, artifact.summary) ? (
                  <div className="companion__artifact-body">{getArtifactBody(artifact.body, artifact.summary)}</div>
                ) : null}
                <span>{artifact.updatedAtLabel}</span>
              </article>
            ))}
          </div>
        </div>

        <div className="companion__panel">
          <div className="companion__panel-header">
            <h2>附件队列</h2>
            <span>{queuedAttachments.length}</span>
          </div>
          <div className="companion__queue">
            {queuedAttachments.length === 0 ? (
              <p className="companion__empty">上传后的图片或文件会先挂在这里，发送消息时一起带上。</p>
            ) : (
              queuedAttachments.map((attachment) => (
                <div key={attachment.id} className="companion__queue-item">
                  <div>
                    <strong>{attachment.fileName}</strong>
                    <span>{formatBytes(attachment.byteSize)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQueuedAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    移除
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="companion__panel">
        <div className="companion__panel-header">
          <h2>设备与任务</h2>
          <span>{onlineDevices.length} 在线</span>
        </div>
        <div className="companion__devices">
          {state.snapshot.devices.map((device) => (
            <div key={device.deviceId} className="companion__device">
              <div>
                <strong>{device.label}</strong>
                <span>{device.deviceType}</span>
              </div>
              <span className={`companion__device-status companion__device-status--${device.status}`}>
                {device.status}
              </span>
            </div>
          ))}
        </div>
        <div className="companion__jobs">
          {latestJobs.map((job) => (
            <div key={`${job.id}-${job.status}`} className="companion__job">
              <div>
                <strong>{job.title}</strong>
                <p>{job.detail}</p>
              </div>
              <span className={`companion__job-status companion__job-status--${job.status}`}>
                {job.status}
              </span>
            </div>
          ))}
        </div>
      </section>

      <form className="companion__composer" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={runtimeOffline ? "桌面 runtime 离线中，草稿会保留在这里。" : "给桌面 Aliceloop 发一条消息..."}
          disabled={state.pendingMessage}
        />
        <div className="companion__composer-actions">
          <label className={`companion__file-button${runtimeOffline ? " companion__file-button--disabled" : ""}`}>
            <input
              type="file"
              multiple
              onChange={handleFileChange}
              disabled={runtimeOffline || state.pendingUpload}
            />
            {state.pendingUpload ? "上传中..." : "上传附件"}
          </label>
          <button type="submit" disabled={runtimeOffline || state.pendingMessage}>
            {state.pendingMessage ? "发送中..." : "发送"}
          </button>
        </div>
        {composerError ? <div className="companion__error">{composerError}</div> : null}
        {state.status === "error" ? (
          <div className="companion__error">
            当前使用预览数据渲染 companion。
            {" "}
            {state.error}
          </div>
        ) : null}
      </form>
    </div>
  );
}
