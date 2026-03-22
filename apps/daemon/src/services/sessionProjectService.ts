import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getProjectDirectory, listProjectDirectorySessionIds } from "../repositories/projectRepository";
import {
  getSessionProjectBinding,
  getSessionSnapshot,
  setSessionProjectBinding,
} from "../repositories/sessionRepository";
import { listSessionGeneratedFiles } from "../repositories/sessionGeneratedFileRepository";

function buildTranscriptExportRoot(projectPath: string, sessionId: string) {
  return resolve(projectPath, ".aliceloop", "sessions", sessionId);
}

function buildTranscriptExportPaths(projectPath: string, sessionId: string) {
  const exportRoot = buildTranscriptExportRoot(projectPath, sessionId);
  return {
    exportRoot,
    markdownPath: join(exportRoot, "session.md"),
    jsonPath: join(exportRoot, "session.json"),
  };
}

function formatMessageRole(role: string) {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return role;
  }
}

function formatConversationTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function quoteFrontmatterValue(value: string) {
  return JSON.stringify(value);
}

function buildTranscriptMarkdown(snapshot: ReturnType<typeof getSessionSnapshot>) {
  const transcriptMessages = snapshot.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const lines: string[] = [
    "---",
    `threadId: ${snapshot.session.id}`,
    `title: ${quoteFrontmatterValue(snapshot.session.title)}`,
    `createdAt: ${snapshot.session.createdAt}`,
    `updatedAt: ${snapshot.session.updatedAt}`,
    "model: unknown",
    `messageCount: ${transcriptMessages.length}`,
    "---",
    "",
  ];

  if (transcriptMessages.length === 0) {
    lines.push("_No user or assistant messages yet._", "");
  } else {
    for (const message of transcriptMessages) {
      lines.push(`## ${formatMessageRole(message.role)} (${formatConversationTimestamp(message.createdAt)})`);
      lines.push("");
      lines.push(message.content || "_(empty)_");
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function syncSessionProjectHistory(sessionId: string) {
  const binding = getSessionProjectBinding(sessionId);
  if (!binding?.projectPath) {
    return {
      binding: null,
      markdownPath: null,
      jsonPath: null,
    };
  }

  const snapshot = getSessionSnapshot(sessionId);
  const generatedFiles = listSessionGeneratedFiles(sessionId);
  const exportedAt = new Date().toISOString();
  const exportPaths = buildTranscriptExportPaths(binding.projectPath, sessionId);

  await mkdir(exportPaths.exportRoot, { recursive: true });

  const payload = {
    exportedAt,
    project: binding,
    session: snapshot.session,
    messages: snapshot.messages,
    attachments: snapshot.attachments,
    jobs: snapshot.jobs,
    artifacts: snapshot.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      updatedAt: artifact.updatedAt,
    })),
    generatedFiles,
  };

  await writeFile(exportPaths.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(exportPaths.markdownPath, buildTranscriptMarkdown(snapshot), "utf8");

  return {
    binding,
    markdownPath: exportPaths.markdownPath,
    jsonPath: exportPaths.jsonPath,
  };
}

export async function assignSessionProjectAndSync(sessionId: string, projectId: string | null) {
  const previousBinding = getSessionProjectBinding(sessionId);
  const nextBinding = setSessionProjectBinding(sessionId, projectId);

  if (previousBinding?.projectPath && previousBinding.projectPath !== nextBinding?.projectPath) {
    await rm(buildTranscriptExportRoot(previousBinding.projectPath, sessionId), { recursive: true, force: true });
  }

  if (!nextBinding?.projectPath) {
    return {
      binding: null,
      markdownPath: null,
      jsonPath: null,
    };
  }

  return syncSessionProjectHistory(sessionId);
}

export async function resyncProjectSessionHistories(projectId: string, previousProjectPath?: string | null) {
  const project = getProjectDirectory(projectId);
  const sessionIds = listProjectDirectorySessionIds(projectId);
  const migratedSessionIds: string[] = [];

  for (const sessionId of sessionIds) {
    if (previousProjectPath && previousProjectPath !== project.path) {
      await rm(buildTranscriptExportRoot(previousProjectPath, sessionId), { recursive: true, force: true });
    }

    await syncSessionProjectHistory(sessionId);
    migratedSessionIds.push(sessionId);
  }

  return {
    project,
    sessionCount: migratedSessionIds.length,
    migratedSessionIds,
  };
}
