import { mkdir, writeFile } from "node:fs/promises";
import { getProjectDirectory, listProjectDirectories, listProjectDirectorySessionIds } from "../repositories/projectRepository";
import {
  getSessionProjectBinding,
  getSessionSnapshot,
  setSessionProjectBinding,
} from "../repositories/sessionRepository";
import {
  buildThreadTranscriptExportPaths,
  clearSessionTranscriptExports,
  clearLegacyTranscriptRoot,
  pruneEmptyTranscriptParents,
} from "./threadTranscriptPaths";

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

function buildTranscriptMarkdown(snapshot: ReturnType<typeof getSessionSnapshot>) {
  const transcriptMessages = snapshot.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const lines: string[] = [
    "---",
    `threadId: ${snapshot.session.id}`,
    `title: ""`,
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
    };
  }

  const snapshot = getSessionSnapshot(sessionId);
  clearSessionTranscriptExports(binding.projectPath, sessionId);
  const exportPaths = buildThreadTranscriptExportPaths(binding.projectPath, {
    sessionId,
    sessionTitle: snapshot.session.title,
    sessionCreatedAt: snapshot.session.createdAt,
  });

  await mkdir(exportPaths.exportRoot, { recursive: true });
  await writeFile(exportPaths.markdownPath, buildTranscriptMarkdown(snapshot), "utf8");
  pruneEmptyTranscriptParents(binding.projectPath);

  return {
    binding,
    markdownPath: exportPaths.markdownPath,
  };
}

export async function assignSessionProjectAndSync(sessionId: string, projectId: string | null) {
  const previousBinding = getSessionProjectBinding(sessionId);
  const nextBinding = setSessionProjectBinding(sessionId, projectId);

  if (previousBinding?.projectPath && previousBinding.projectPath !== nextBinding?.projectPath) {
    clearSessionTranscriptExports(previousBinding.projectPath, sessionId);
    pruneEmptyTranscriptParents(previousBinding.projectPath);
  }

  if (!nextBinding?.projectPath) {
    return {
      binding: null,
      markdownPath: null,
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
      clearSessionTranscriptExports(previousProjectPath, sessionId);
    }

    await syncSessionProjectHistory(sessionId);
    migratedSessionIds.push(sessionId);
  }

  if (previousProjectPath && previousProjectPath !== project.path) {
    pruneEmptyTranscriptParents(previousProjectPath);
    clearLegacyTranscriptRoot(previousProjectPath);
  }
  pruneEmptyTranscriptParents(project.path);
  clearLegacyTranscriptRoot(project.path);

  return {
    project,
    sessionCount: migratedSessionIds.length,
    migratedSessionIds,
  };
}

export async function resyncAllProjectSessionHistories() {
  const projects = listProjectDirectories();
  let sessionCount = 0;

  for (const project of projects) {
    const result = await resyncProjectSessionHistories(project.id);
    sessionCount += result.sessionCount;
  }

  return {
    projectCount: projects.length,
    sessionCount,
  };
}
