import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ThreadTranscriptDescriptor {
  sessionId: string;
  sessionTitle: string;
  sessionCreatedAt: string;
}

function formatThreadDate(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp.slice(0, 10) || "unknown-date";
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizeThreadFilePart(value: string) {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

function buildThreadTranscriptBaseName(descriptor: ThreadTranscriptDescriptor) {
  const datePart = formatThreadDate(descriptor.sessionCreatedAt);
  const titlePart = sanitizeThreadFilePart(descriptor.sessionTitle) || "新对话";
  const sessionSuffix = descriptor.sessionId.slice(0, 8);
  return `${datePart}_${titlePart}_${sessionSuffix}`;
}

function buildLegacyTranscriptExportRoot(projectPath: string, sessionId: string) {
  return resolve(projectPath, ".aliceloop", "sessions", sessionId);
}

function buildThreadTranscriptExportRoot(projectPath: string) {
  return resolve(projectPath, "threads");
}

function removeEmptyDirectory(directoryPath: string) {
  try {
    if (readdirSync(directoryPath).length === 0) {
      rmSync(directoryPath, { recursive: true, force: true });
    }
  } catch {
    // Ignore missing directories.
  }
}

export function buildThreadTranscriptExportPaths(projectPath: string, descriptor: ThreadTranscriptDescriptor) {
  const exportRoot = buildThreadTranscriptExportRoot(projectPath);
  const baseName = buildThreadTranscriptBaseName(descriptor);
  return {
    exportRoot,
    baseName,
    markdownPath: join(exportRoot, `${baseName}.md`),
  };
}

export function clearSessionTranscriptExports(projectPath: string, sessionId: string) {
  rmSync(buildLegacyTranscriptExportRoot(projectPath, sessionId), { recursive: true, force: true });

  const exportRoot = buildThreadTranscriptExportRoot(projectPath);
  const sessionSuffix = `_${sessionId.slice(0, 8)}`;

  let entries: string[] = [];
  try {
    entries = readdirSync(exportRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") && !entry.endsWith(".json")) {
      continue;
    }

    if (!entry.endsWith(`${sessionSuffix}.md`) && !entry.endsWith(`${sessionSuffix}.json`)) {
      continue;
    }

    rmSync(join(exportRoot, entry), { force: true });
  }
}

export function pruneEmptyTranscriptParents(projectPath: string) {
  removeEmptyDirectory(resolve(projectPath, ".aliceloop", "sessions"));
  removeEmptyDirectory(resolve(projectPath, ".aliceloop"));
}

export function clearLegacyTranscriptRoot(projectPath: string) {
  rmSync(resolve(projectPath, ".aliceloop", "sessions"), { recursive: true, force: true });
  pruneEmptyTranscriptParents(projectPath);
}
