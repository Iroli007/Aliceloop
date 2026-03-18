import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ArtifactKind, StudyArtifact } from "@aliceloop/runtime-core";
import { publishSessionEvent } from "../realtime/sessionStreams";
import { getPrimaryLibraryContext, upsertStudyArtifact } from "../repositories/overviewRepository";
import { recordArtifactEvent, recordArtifactUpdate, upsertSessionJob } from "../repositories/sessionRepository";

const artifactKeywords = ["整理", "提纲", "学习页", "复习", "结构", "清单", "总结", "归纳", "速记"];
const artifactChunkDelayMs = 120;

function shouldCreateArtifact(userText: string) {
  return artifactKeywords.some((keyword) => userText.includes(keyword));
}

function summarize(text: string, maxLength: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}…`;
}

function buildArtifactBody(userText: string, assistantText: string) {
  const cleanedReply = assistantText.trim();
  if (!cleanedReply) {
    return userText.trim();
  }

  if (cleanedReply.includes("\n")) {
    return cleanedReply;
  }

  return `${cleanedReply}\n\n请求意图：${userText.trim()}`;
}

function inferKind(userText: string): ArtifactKind {
  if (userText.includes("复习")) {
    return "review-pack";
  }

  if (userText.includes("专题")) {
    return "topic-page";
  }

  return "study-page";
}

function inferTitle(userText: string, kind: ArtifactKind, relatedLibraryTitle: string) {
  if (userText.includes("提纲")) {
    return `${relatedLibraryTitle} · 速记提纲`;
  }

  if (kind === "review-pack") {
    return `${relatedLibraryTitle} · 复习卡`;
  }

  if (kind === "topic-page") {
    return `${relatedLibraryTitle} · 专题页`;
  }

  return `${relatedLibraryTitle} · 学习页`;
}

function publishArtifactJobUpdate(
  jobId: string,
  sessionId: string,
  status: "queued" | "running" | "done" | "failed",
  title: string,
  detail: string,
) {
  const result = upsertSessionJob({
    id: jobId,
    sessionId,
    kind: "study-artifact",
    status,
    title,
    detail,
  });
  publishSessionEvent(result.event);
}

function chunkArtifactBody(body: string) {
  const chunks: string[] = [];
  let pendingBlankLine = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      pendingBlankLine = true;
      continue;
    }

    const prefix = chunks.length === 0 ? "" : pendingBlankLine ? "\n\n" : "\n";
    chunks.push(`${prefix}${line}`);
    pendingBlankLine = false;
  }

  return chunks.length > 0 ? chunks : [body];
}

function publishArtifactLifecycleEvent(
  sessionId: string,
  type: "artifact.created" | "artifact.block.created" | "artifact.block.append" | "artifact.done" | "artifact.updated",
  payload: Record<string, unknown>,
  createdAt: string,
) {
  const event = recordArtifactEvent(sessionId, type, payload, createdAt);
  publishSessionEvent(event);
  return event;
}

function buildArtifactShell(userText: string, relatedLibraryTitle: string, libraryItemId: string) {
  const kind = inferKind(userText);
  const now = new Date().toISOString();

  const artifact: StudyArtifact = {
    id: `artifact-${randomUUID()}`,
    libraryItemId,
    kind,
    title: inferTitle(userText, kind, relatedLibraryTitle),
    summary: "",
    body: "",
    relatedLibraryTitle,
    updatedAt: now,
    updatedAtLabel: "正在生成",
  };

  return artifact;
}

export async function maybeCreateArtifactFromReply(sessionId: string, userText: string, assistantText: string) {
  if (!shouldCreateArtifact(userText)) {
    return null;
  }

  const { libraryItemId, relatedLibraryTitle } = getPrimaryLibraryContext();
  const artifact = buildArtifactShell(userText, relatedLibraryTitle, libraryItemId);
  const blockId = `${artifact.id}-body`;
  const jobId = randomUUID();

  try {
    const finalBody = buildArtifactBody(userText, assistantText);
    const chunks = chunkArtifactBody(finalBody);

    publishArtifactJobUpdate(jobId, sessionId, "queued", `准备生成工件 · ${artifact.title}`, "已识别出结构化输出，准备开始流式写入工件。");

    upsertStudyArtifact(artifact);
    publishArtifactLifecycleEvent(sessionId, "artifact.created", { artifact }, artifact.updatedAt);
    publishArtifactLifecycleEvent(
      sessionId,
      "artifact.block.created",
      {
        artifactId: artifact.id,
        blockId,
        blockKind: "body",
        artifact,
      },
      artifact.updatedAt,
    );
    publishArtifactJobUpdate(jobId, sessionId, "running", `正在生成工件 · ${artifact.title}`, "工件已创建，正在把回复逐段写入中心工作区。");

    let currentArtifact = artifact;

    for (const chunk of chunks) {
      await delay(artifactChunkDelayMs);

      const nextBody = `${currentArtifact.body}${chunk}`;
      const updatedAt = new Date().toISOString();
      currentArtifact = {
        ...currentArtifact,
        body: nextBody,
        summary: summarize(nextBody, 120),
        updatedAt,
        updatedAtLabel: "正在生成",
      };

      upsertStudyArtifact(currentArtifact);
      publishArtifactLifecycleEvent(
        sessionId,
        "artifact.block.append",
        {
          artifactId: currentArtifact.id,
          blockId,
          textDelta: chunk,
          artifact: currentArtifact,
        },
        updatedAt,
      );
    }

    const completedArtifact: StudyArtifact = {
      ...currentArtifact,
      summary: summarize(assistantText, 120),
      body: finalBody,
      updatedAt: new Date().toISOString(),
      updatedAtLabel: "刚刚更新",
    };

    upsertStudyArtifact(completedArtifact);
    publishArtifactLifecycleEvent(sessionId, "artifact.done", { artifact: completedArtifact }, completedArtifact.updatedAt);
    publishSessionEvent(recordArtifactUpdate(sessionId, completedArtifact));
    publishArtifactJobUpdate(
      jobId,
      sessionId,
      "done",
      `已生成工件 · ${completedArtifact.title}`,
      "这轮回复已经按块流式写入工件，桌面和 companion 会共享同一份正文。",
    );
    return completedArtifact;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "工件流式写入失败";
    publishArtifactJobUpdate(jobId, sessionId, "failed", `工件生成失败 · ${artifact.title}`, detail);
    throw error;
  }
}
