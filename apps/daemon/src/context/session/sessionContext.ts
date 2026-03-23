import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ModelMessage } from "ai";
import type { SessionMessage } from "@aliceloop/runtime-core";
import { getSessionSnapshot } from "../../repositories/sessionRepository";

const MAX_HISTORY_MESSAGES = 20;
const MAX_INLINE_ATTACHMENT_BYTES = 48 * 1024;
const MAX_TOTAL_INLINE_ATTACHMENT_BYTES = 96 * 1024;
const MAX_INLINE_ATTACHMENT_CHARS = 24_000;
const MAX_DIRECTORY_TREE_ENTRIES = 80;
const MAX_DIRECTORY_TREE_DEPTH = 4;
const TEXT_LIKE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".markdown",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isInlineTextAttachment(fileName: string, mimeType: string) {
  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (
    mimeType.includes("json")
    || mimeType.includes("javascript")
    || mimeType.includes("typescript")
    || mimeType.includes("xml")
    || mimeType.includes("yaml")
    || mimeType.includes("markdown")
    || mimeType.includes("svg")
  ) {
    return true;
  }

  return TEXT_LIKE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function readInlineAttachmentPreview(path: string, fileName: string, mimeType: string, remainingBudget: number) {
  if (!isInlineTextAttachment(fileName, mimeType) || remainingBudget <= 0) {
    return null;
  }

  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_INLINE_ATTACHMENT_BYTES || stats.size > remainingBudget) {
      return null;
    }

    const content = readFileSync(path, "utf8");
    if (!content.trim()) {
      return null;
    }

    const trimmedContent = content.length > MAX_INLINE_ATTACHMENT_CHARS
      ? `${content.slice(0, MAX_INLINE_ATTACHMENT_CHARS).trimEnd()}\n... [truncated]`
      : content;

    return {
      content: trimmedContent,
      byteSize: stats.size,
    };
  } catch {
    return null;
  }
}

function buildDirectoryTreeLines(
  dirPath: string,
  depth = 0,
  lines: string[] = [],
): string[] {
  if (depth >= MAX_DIRECTORY_TREE_DEPTH || lines.length >= MAX_DIRECTORY_TREE_ENTRIES) {
    return lines;
  }

  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "en");
      });
  } catch {
    return lines;
  }

  for (const entry of entries) {
    if (lines.length >= MAX_DIRECTORY_TREE_ENTRIES) {
      break;
    }

    const prefix = `${"  ".repeat(depth)}- `;
    lines.push(`${prefix}${entry.name}${entry.isDirectory ? "/" : ""}`);

    if (entry.isDirectory) {
      buildDirectoryTreeLines(join(dirPath, entry.name), depth + 1, lines);
    }
  }

  return lines;
}

function buildDirectoryAttachmentPreview(path: string, mimeType: string) {
  if (mimeType !== "inode/directory") {
    return null;
  }

  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      return null;
    }

    const lines = buildDirectoryTreeLines(path);
    if (lines.length === 0) {
      return "[empty directory]";
    }

    const suffix = lines.length >= MAX_DIRECTORY_TREE_ENTRIES
      ? "\n... [directory tree truncated]"
      : "";

    return `${lines.join("\n")}${suffix}`;
  } catch {
    return null;
  }
}

function getLatestUserSessionMessage(messages: SessionMessage[]): SessionMessage | null {
  return [...messages].reverse().find((message) => message.role === "user") ?? null;
}

function sessionMessageToCore(message: SessionMessage): ModelMessage {
  const content = serializeMessageContent(message);

  if (message.role === "user") {
    return { role: "user", content };
  }

  if (message.role === "assistant") {
    return { role: "assistant", content };
  }

  return { role: "system", content };
}

function serializeMessageContent(message: SessionMessage): string {
  if (message.attachments.length === 0) {
    return message.content;
  }

  let remainingInlineBudget = MAX_TOTAL_INLINE_ATTACHMENT_BYTES;
  const attachmentSummary = message.attachments
    .map((attachment) => {
      const binaryNote = attachment.mimeType.startsWith("image/")
        ? ", binary image attachment"
        : "";
      const path = attachment.originalPath || attachment.storagePath;
      return `${attachment.fileName} (${attachment.mimeType}, path: ${path}${binaryNote})`;
    })
    .join(", ");
  const inlineAttachmentBlocks = message.attachments
    .map((attachment) => {
      const path = attachment.originalPath || attachment.storagePath;
      const directoryPreview = buildDirectoryAttachmentPreview(path, attachment.mimeType);
      if (directoryPreview) {
        return [
          `[Attached directory tree: ${attachment.fileName}]`,
          directoryPreview,
        ].join("\n");
      }

      const preview = readInlineAttachmentPreview(path, attachment.fileName, attachment.mimeType, remainingInlineBudget);
      if (!preview) {
        return null;
      }

      remainingInlineBudget -= preview.byteSize;
      return [
        `[Attached file content: ${attachment.fileName}]`,
        preview.content,
      ].join("\n");
    })
    .filter((block): block is string => Boolean(block));

  const parts: string[] = [];

  if (message.content.trim()) {
    parts.push(message.content);
  }

  parts.push(`[Attached files: ${attachmentSummary}]`);

  if (inlineAttachmentBlocks.length > 0) {
    parts.push(...inlineAttachmentBlocks);
  }

  return parts.join("\n\n");
}

export function buildSessionMessages(sessionId: string): ModelMessage[] {
  const snapshot = getSessionSnapshot(sessionId);
  const messages = snapshot.messages
    .filter((m) => m.role !== "system")
    .slice(-MAX_HISTORY_MESSAGES);

  return messages.map(sessionMessageToCore);
}

export function buildActiveTurnBlock(sessionId: string): string {
  const snapshot = getSessionSnapshot(sessionId);
  const latestUserMessage = getLatestUserSessionMessage(snapshot.messages);

  if (!latestUserMessage) {
    return "";
  }

  const latestContent = serializeMessageContent(latestUserMessage).trim();
  if (!latestContent) {
    return "";
  }

  return [
    "## Active Turn",
    "- The final user message in the conversation history is the only current request for this turn.",
    "- Treat older conversation as background context. Do not claim the user just said, repeated, or confirmed something unless it appears in the latest user message below.",
    "- If a nickname, preference, or instruction appears only in older history, treat it as past context rather than a fresh instruction in this reply.",
    "- When the latest user message conflicts with, narrows, or replaces an older framing, follow the latest user message.",
    "",
    "<latest_user_message>",
    latestContent,
    "</latest_user_message>",
  ].join("\n");
}

export function getLatestUserMessage(sessionId: string): string | null {
  const snapshot = getSessionSnapshot(sessionId);
  const userMessage = getLatestUserSessionMessage(snapshot.messages);

  return userMessage?.content ?? null;
}
