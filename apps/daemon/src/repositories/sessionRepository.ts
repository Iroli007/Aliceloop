import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Attachment,
  type DeviceCapabilities,
  type DevicePresence,
  type DeviceStatus,
  type DeviceType,
  type JobRunDetail,
  type ProjectDirectoryKind,
  type RuntimePresence,
  type Session,
  type SessionEvent,
  type SessionMessage,
  type SessionMessageStatus,
  type SessionProjectBinding,
  type SessionRole,
  type SessionSnapshot,
  type SessionThreadSummary,
  type StudyArtifact,
  type ToolApproval,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";
import { getShellOverview } from "./overviewRepository";
import { syncTaskRunFromJob } from "./taskRunRepository";
import { listPendingToolApprovals } from "../services/toolApprovalBroker";
import { getDefaultProjectDirectory, getProjectDirectory } from "./projectRepository";
import {
  buildThreadTranscriptExportPaths,
  clearSessionTranscriptExports,
  pruneEmptyTranscriptParents,
} from "../services/threadTranscriptPaths";

const runtimeHeartbeatWindowMs = 25_000;

interface SessionRow {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionProjectBindingRow {
  sessionId: string;
  sessionTitle: string;
  sessionCreatedAt: string;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  projectKind: ProjectDirectoryKind | null;
}

interface AttachmentRow {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
  originalPath: string | null;
  status: Attachment["status"];
  createdAt: string;
}

interface SessionMessageRow {
  id: string;
  sessionId: string;
  clientMessageId: string;
  role: SessionRole;
  content: string;
  attachmentIds: string;
  status: SessionMessageStatus;
  sourceDeviceId: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionEventRow {
  id: string;
  seq: number;
  sessionId: string;
  type: SessionEvent["type"];
  payload: string;
  createdAt: string;
}

interface MessageReactionRow {
  id: string;
  sessionId: string;
  messageId: string;
  emoji: string;
  sourceDeviceId: string;
  createdAt: string;
}

interface DevicePresenceRow {
  deviceId: string;
  deviceType: DeviceType;
  label: string;
  status: DeviceStatus;
  lastSeenAt: string;
  capabilitiesJson: string;
}

interface JobRunRow {
  id: string;
  sessionId: string;
  kind: string;
  status: JobRunDetail["status"];
  title: string;
  detail: string;
  updatedAt: string;
}

interface SessionThreadSummaryRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  latestMessagePreview: string | null;
  latestMessageAt: string | null;
  matchedPreview: string | null;
  matchedMessageCreatedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  projectKind: ProjectDirectoryKind | null;
}

interface SessionConversationMessageRow {
  role: SessionRole;
  content: string;
  createdAt: string;
}

interface CreateMessageInput {
  sessionId: string;
  clientMessageId: string;
  deviceId: string;
  role: SessionRole;
  content: string;
  attachmentIds: string[];
  eventPayload?: Record<string, unknown>;
}

interface CreateAttachmentInput {
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
  originalPath?: string;
}

interface HeartbeatInput {
  deviceId: string;
  deviceType: DeviceType;
  label: string;
  sessionId: string;
  capabilities?: DeviceCapabilities;
}

interface UpsertJobInput {
  id: string;
  sessionId: string;
  kind: string;
  status: JobRunDetail["status"];
  title: string;
  detail: string;
}

export interface SessionMessageReaction {
  id: string;
  sessionId: string;
  messageId: string;
  emoji: string;
  deviceId: string;
  createdAt: string;
}

export interface SessionConversationMessage {
  role: SessionRole;
  content: string;
  createdAt: string;
}

function summarizeMessagePreview(content: string | null) {
  if (!content) {
    return null;
  }

  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 72 ? `${normalized.slice(0, 72).trimEnd()}…` : normalized;
}

function summarizeSessionTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "新对话";
  }

  return normalized.length > 24 ? `${normalized.slice(0, 24).trimEnd()}…` : normalized;
}

function escapeSqlLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function findTranscriptArchiveMatch(
  transcriptPath: string,
  queryText: string,
) {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  let content = "";
  try {
    content = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const normalizedQuery = queryText.trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const normalizedContent = content.toLowerCase();
  if (!normalizedContent.includes(normalizedQuery)) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  let currentTimestamp: string | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^## [^(]+ \(([^)]+)\)$/);
    if (headingMatch) {
      currentTimestamp = headingMatch[1] ?? null;
      continue;
    }

    if (line.toLowerCase().includes(normalizedQuery)) {
      const preview = line.trim();
      return {
        matchedPreview: preview.length > 0 ? summarizeMessagePreview(preview) : null,
        matchedMessageCreatedAt: currentTimestamp,
      };
    }
  }

  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return null;
  }

  const preview = content
    .slice(Math.max(0, matchIndex - 80), Math.min(content.length, matchIndex + normalizedQuery.length + 80))
    .replace(/\s+/g, " ")
    .trim();

  return {
    matchedPreview: preview.length > 0 ? summarizeMessagePreview(preview) : null,
    matchedMessageCreatedAt: null,
  };
}

function toMessage(row: SessionMessageRow, attachments: Attachment[]): SessionMessage {
  const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, attachment]));

  return {
    id: row.id,
    sessionId: row.sessionId,
    clientMessageId: row.clientMessageId,
    role: row.role,
    content: row.content,
    attachments: JSON.parse(row.attachmentIds)
      .map((attachmentId: string) => attachmentMap.get(attachmentId))
      .filter((attachment: Attachment | undefined): attachment is Attachment => Boolean(attachment)),
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    storagePath: row.storagePath,
    originalPath: row.originalPath ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toMessageReaction(row: MessageReactionRow): SessionMessageReaction {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    emoji: row.emoji,
    deviceId: row.sourceDeviceId,
    createdAt: row.createdAt,
  };
}

function toSessionProjectBinding(row: SessionProjectBindingRow | undefined): SessionProjectBinding | null {
  if (!row || !row.projectId || !row.projectPath) {
    return null;
  }

  const transcriptPaths = buildThreadTranscriptExportPaths(row.projectPath, {
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    sessionCreatedAt: row.sessionCreatedAt,
  });
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    projectName: row.projectName,
    projectPath: row.projectPath,
    projectKind: row.projectKind,
    transcriptMarkdownPath: transcriptPaths.markdownPath,
  };
}

function listAttachments(sessionId: string): Attachment[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          file_name AS fileName,
          mime_type AS mimeType,
          byte_size AS byteSize,
          storage_path AS storagePath,
          original_path AS originalPath,
          status,
          created_at AS createdAt
        FROM attachments
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(sessionId) as AttachmentRow[];

  return rows.map(toAttachment);
}

export function getSessionAttachment(sessionId: string, attachmentId: string): Attachment | null {
  return listAttachments(sessionId).find((attachment) => attachment.id === attachmentId) ?? null;
}

function listMessageReactions(sessionId: string, messageId: string): SessionMessageReaction[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          message_id AS messageId,
          emoji,
          source_device_id AS sourceDeviceId,
          created_at AS createdAt
        FROM message_reactions
        WHERE session_id = ?
          AND message_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(sessionId, messageId) as MessageReactionRow[];

  return rows.map(toMessageReaction);
}

function uniqueSandboxRoots(roots: string[]) {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function resolveAttachmentSandboxRoot(storagePath: string) {
  const targetPath = resolve(storagePath);

  try {
    const stats = statSync(targetPath);
    if (stats.isDirectory()) {
      return {
        readRoot: targetPath,
        writeRoot: targetPath,
        cwdRoot: targetPath,
      };
    }
  } catch {
    // Fall back to file-style access when the path is not stat-able yet.
  }

  return {
    readRoot: targetPath,
    writeRoot: targetPath,
    cwdRoot: null,
  };
}

export interface SessionAttachmentSandboxRoots {
  readRoots: string[];
  writeRoots: string[];
  cwdRoots: string[];
  defaultCwd: string | null;
}

export function buildSessionAttachmentSandboxRoots(
  project: SessionProjectBinding | null,
  attachments: Attachment[],
): SessionAttachmentSandboxRoots {
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  const cwdRoots: string[] = [];

  if (project?.projectPath) {
    readRoots.push(project.projectPath);
    writeRoots.push(project.projectPath);
    cwdRoots.push(project.projectPath);
  }

  for (const attachment of attachments) {
    const pathToUse = attachment.originalPath || attachment.storagePath;
    const roots = resolveAttachmentSandboxRoot(pathToUse);
    readRoots.push(roots.readRoot);
    writeRoots.push(roots.writeRoot);
    if (roots.cwdRoot) {
      cwdRoots.push(roots.cwdRoot);
    }
  }

  return {
    readRoots: uniqueSandboxRoots(readRoots),
    writeRoots: uniqueSandboxRoots(writeRoots),
    cwdRoots: uniqueSandboxRoots(cwdRoots),
    defaultCwd: project?.projectPath ?? null,
  };
}

function listMessages(sessionId: string, attachments: Attachment[]): SessionMessage[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          client_message_id AS clientMessageId,
          role,
          content,
          attachment_ids AS attachmentIds,
          status,
          source_device_id AS sourceDeviceId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM session_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(sessionId) as SessionMessageRow[];

  return rows.map((row) => toMessage(row, attachments));
}

function listJobs(sessionId: string): JobRunDetail[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          kind,
          status,
          title,
          detail,
          updated_at AS updatedAt
        FROM job_runs
        WHERE session_id = ?
        ORDER BY updated_at DESC
      `,
    )
    .all(sessionId) as JobRunRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    detail: row.detail,
    updatedAt: row.updatedAt,
  }));
}

function listDevicesRaw(): DevicePresenceRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          device_id AS deviceId,
          device_type AS deviceType,
          label,
          status,
          last_seen_at AS lastSeenAt,
          capabilities_json AS capabilitiesJson
        FROM device_presence
        ORDER BY last_seen_at DESC
      `,
    )
    .all() as DevicePresenceRow[];
}

function parseDeviceCapabilities(raw: string | null | undefined): DeviceCapabilities | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as DeviceCapabilities;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function normalizeDeviceStatus(row: DevicePresenceRow, now = Date.now()): DevicePresence {
  const isFresh = now - new Date(row.lastSeenAt).getTime() <= runtimeHeartbeatWindowMs;
  return {
    deviceId: row.deviceId,
    deviceType: row.deviceType,
    label: row.label,
    lastSeenAt: row.lastSeenAt,
    capabilities: parseDeviceCapabilities(row.capabilitiesJson),
    status: isFresh ? "online" : "offline",
  };
}

function listDevices(now = Date.now()): DevicePresence[] {
  return listDevicesRaw().map((row) => normalizeDeviceStatus(row, now));
}

export function getHealthyBrowserRelayDevice() {
  return listDevices().find((device) => {
    const relay = device.capabilities?.browserRelay;
    return (
      device.deviceType === "desktop" &&
      device.status === "online" &&
      relay?.enabled === true &&
      relay.backend === "desktop_chrome" &&
      relay.healthy === true
    );
  }) ?? null;
}

function buildRuntimePresence(devices: DevicePresence[]): RuntimePresence {
  const desktopDevices = devices
    .filter((device) => device.deviceType === "desktop")
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  const currentHost = desktopDevices.find((device) => device.status === "online") ?? null;
  const latestDesktop = desktopDevices[0] ?? null;

  return {
    online: Boolean(currentHost),
    hostDeviceId: currentHost?.deviceId ?? latestDesktop?.deviceId ?? null,
    hostLabel: currentHost?.label ?? latestDesktop?.label ?? null,
    lastHeartbeatAt: currentHost?.lastSeenAt ?? latestDesktop?.lastSeenAt ?? null,
  };
}

function getSessionRow(sessionId: string): SessionRow | undefined {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          id,
          title,
          project_id AS projectId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM sessions
        WHERE id = ?
      `,
    )
    .get(sessionId) as SessionRow | undefined;
}

export function hasSession(sessionId: string) {
  return Boolean(getSessionRow(sessionId));
}

export function getSessionProjectBinding(sessionId: string): SessionProjectBinding | null {
  const db = getDatabase();
  const row = db.prepare(
    `
      SELECT
        sessions.id AS sessionId,
        sessions.title AS sessionTitle,
        sessions.created_at AS sessionCreatedAt,
        projects.id AS projectId,
        projects.name AS projectName,
        projects.path AS projectPath,
        projects.kind AS projectKind
      FROM sessions
      LEFT JOIN projects
        ON projects.id = sessions.project_id
      WHERE sessions.id = ?
      LIMIT 1
    `,
  ).get(sessionId) as SessionProjectBindingRow | undefined;

  return toSessionProjectBinding(row);
}

function countMessagesForSession(sessionId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM session_messages
        WHERE session_id = ?
      `,
    )
    .get(sessionId) as { count: number };

  return row.count;
}

function toSessionThreadSummary(row: SessionThreadSummaryRow): SessionThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
    latestMessagePreview: summarizeMessagePreview(row.latestMessagePreview),
    latestMessageAt: row.latestMessageAt,
    matchedPreview: summarizeMessagePreview(row.matchedPreview),
    matchedMessageCreatedAt: row.matchedMessageCreatedAt,
    projectId: row.projectId,
    projectName: row.projectName,
    projectPath: row.projectPath,
    projectKind: row.projectKind,
  };
}

function findReusableDraftSession(projectId: string | null): SessionThreadSummary | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          sessions.id AS id,
          sessions.title AS title,
          sessions.created_at AS createdAt,
          sessions.updated_at AS updatedAt,
          0 AS messageCount,
          NULL AS latestMessagePreview,
          NULL AS latestMessageAt,
          NULL AS matchedPreview,
          NULL AS matchedMessageCreatedAt,
          projects.id AS projectId,
          projects.name AS projectName,
          projects.path AS projectPath,
          projects.kind AS projectKind
        FROM sessions
        LEFT JOIN projects
          ON projects.id = sessions.project_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM session_messages
          WHERE session_messages.session_id = sessions.id
        )
          AND NOT EXISTS (
            SELECT 1
            FROM attachments
            WHERE attachments.session_id = sessions.id
          )
          AND NOT EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.session_id = sessions.id
        )
          AND (
            (? IS NULL AND sessions.project_id IS NULL)
            OR sessions.project_id = ?
          )
        ORDER BY sessions.updated_at DESC, sessions.created_at DESC
        LIMIT 1
      `,
    )
    .get(projectId, projectId) as SessionThreadSummaryRow | undefined;

  return row ? toSessionThreadSummary(row) : null;
}

export function listSessionThreads(): SessionThreadSummary[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          sessions.id AS id,
          sessions.title AS title,
          sessions.created_at AS createdAt,
          sessions.updated_at AS updatedAt,
          COALESCE(message_counts.messageCount, 0) AS messageCount,
          latest_message.content AS latestMessagePreview,
          latest_message.created_at AS latestMessageAt,
          NULL AS matchedPreview,
          NULL AS matchedMessageCreatedAt,
          projects.id AS projectId,
          projects.name AS projectName,
          projects.path AS projectPath,
          projects.kind AS projectKind
        FROM sessions
        LEFT JOIN projects
          ON projects.id = sessions.project_id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*) AS messageCount
          FROM session_messages
          GROUP BY session_id
        ) AS message_counts
          ON message_counts.session_id = sessions.id
        LEFT JOIN session_messages AS latest_message
          ON latest_message.id = (
            SELECT id
            FROM session_messages
            WHERE session_id = sessions.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        WHERE COALESCE(message_counts.messageCount, 0) > 0
        ORDER BY sessions.updated_at DESC, sessions.created_at DESC
      `,
    )
    .all() as SessionThreadSummaryRow[];

  return rows.map(toSessionThreadSummary);
}

export function listHistoricalSessionCandidates(
  excludedSessionId: string,
  options: { projectId?: string | null; limit?: number } = {},
): SessionThreadSummary[] {
  const db = getDatabase();
  const normalizedLimit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const projectId = options.projectId ?? null;

  const rows = db
    .prepare(
      `
        SELECT
          sessions.id AS id,
          sessions.title AS title,
          sessions.created_at AS createdAt,
          sessions.updated_at AS updatedAt,
          COALESCE(message_counts.messageCount, 0) AS messageCount,
          latest_message.content AS latestMessagePreview,
          latest_message.created_at AS latestMessageAt,
          NULL AS matchedPreview,
          NULL AS matchedMessageCreatedAt,
          projects.id AS projectId,
          projects.name AS projectName,
          projects.path AS projectPath,
          projects.kind AS projectKind
        FROM sessions
        LEFT JOIN projects
          ON projects.id = sessions.project_id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*) AS messageCount
          FROM session_messages
          WHERE role IN ('user', 'assistant')
          GROUP BY session_id
        ) AS message_counts
          ON message_counts.session_id = sessions.id
        LEFT JOIN session_messages AS latest_message
          ON latest_message.id = (
            SELECT id
            FROM session_messages
            WHERE session_id = sessions.id
              AND role IN ('user', 'assistant')
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        WHERE sessions.id <> ?
          AND COALESCE(message_counts.messageCount, 0) > 0
        ORDER BY
          CASE
            WHEN ? IS NOT NULL AND sessions.project_id = ? THEN 0
            ELSE 1
          END ASC,
          sessions.updated_at DESC,
          sessions.created_at DESC
        LIMIT ?
      `,
    )
    .all(excludedSessionId, projectId, projectId, normalizedLimit) as SessionThreadSummaryRow[];

  return rows.map(toSessionThreadSummary);
}

export function listSessionConversationMessages(
  sessionId: string,
  limit = 24,
): SessionConversationMessage[] {
  const db = getDatabase();
  const normalizedLimit = Math.max(1, Math.min(limit, 200));
  const rows = db
    .prepare(
      `
        SELECT
          role,
          content,
          createdAt
        FROM (
          SELECT
            role,
            content,
            created_at AS createdAt
          FROM session_messages
          WHERE session_id = ?
            AND role IN ('user', 'assistant')
            AND TRIM(content) <> ''
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        )
        ORDER BY createdAt ASC
      `,
    )
    .all(sessionId, normalizedLimit) as SessionConversationMessageRow[];

  return rows;
}

export function searchSessionThreads(query: string, limit = 10): SessionThreadSummary[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.min(limit, 100));
  const archiveResults: SessionThreadSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const thread of listSessionThreads()) {
    if (archiveResults.length >= normalizedLimit) {
      break;
    }

    if (!thread.projectPath) {
      continue;
    }

    const transcriptPath = buildThreadTranscriptExportPaths(thread.projectPath, {
      sessionId: thread.id,
      sessionTitle: thread.title,
      sessionCreatedAt: thread.createdAt,
    }).markdownPath;
    const archiveMatch = findTranscriptArchiveMatch(transcriptPath, trimmedQuery);
    if (!archiveMatch) {
      continue;
    }

    archiveResults.push({
      ...thread,
      matchedPreview: archiveMatch.matchedPreview,
      matchedMessageCreatedAt: archiveMatch.matchedMessageCreatedAt,
    });
    seenSessionIds.add(thread.id);
  }

  if (archiveResults.length >= normalizedLimit) {
    return archiveResults;
  }

  const db = getDatabase();
  const likePattern = `%${escapeSqlLikePattern(trimmedQuery)}%`;
  const rows = db
    .prepare(
      `
        SELECT
          sessions.id AS id,
          sessions.title AS title,
          sessions.created_at AS createdAt,
          sessions.updated_at AS updatedAt,
          COALESCE(message_counts.messageCount, 0) AS messageCount,
          latest_message.content AS latestMessagePreview,
          latest_message.created_at AS latestMessageAt,
          matched_message.content AS matchedPreview,
          matched_message.created_at AS matchedMessageCreatedAt,
          projects.id AS projectId,
          projects.name AS projectName,
          projects.path AS projectPath,
          projects.kind AS projectKind
        FROM sessions
        LEFT JOIN projects
          ON projects.id = sessions.project_id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*) AS messageCount
          FROM session_messages
          WHERE role IN ('user', 'assistant')
          GROUP BY session_id
        ) AS message_counts
          ON message_counts.session_id = sessions.id
        LEFT JOIN session_messages AS latest_message
          ON latest_message.id = (
            SELECT id
            FROM session_messages
            WHERE session_id = sessions.id
              AND role IN ('user', 'assistant')
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        LEFT JOIN session_messages AS matched_message
          ON matched_message.id = (
            SELECT id
            FROM session_messages
            WHERE session_id = sessions.id
              AND role IN ('user', 'assistant')
              AND TRIM(content) <> ''
              AND content LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        WHERE matched_message.id IS NOT NULL
        ORDER BY matched_message.created_at DESC, sessions.updated_at DESC, sessions.created_at DESC
        LIMIT ?
      `,
    )
    .all(likePattern, normalizedLimit) as SessionThreadSummaryRow[];

  const fallbackResults = rows
    .map(toSessionThreadSummary)
    .filter((thread) => !seenSessionIds.has(thread.id));

  return [...archiveResults, ...fallbackResults].slice(0, normalizedLimit);
}

export function createSession(
  input: string | { title?: string; projectId?: string | null } = {},
): SessionThreadSummary {
  const normalizedInput = typeof input === "string" ? { title: input } : input;
  const projectId = normalizedInput.projectId === undefined
    ? getDefaultProjectDirectory().id
    : normalizedInput.projectId;

  if (projectId) {
    getProjectDirectory(projectId);
  }

  if (!normalizedInput.title?.trim()) {
    const reusableDraft = findReusableDraftSession(projectId ?? null);
    if (reusableDraft) {
      return reusableDraft;
    }
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
  const nextTitle = normalizedInput.title?.trim()
    ? normalizedInput.title.trim()
    : countRow.count === 0
      ? "新对话"
      : `新对话 ${countRow.count + 1}`;

  db.prepare(
    `
      INSERT INTO sessions (
        id, title, project_id, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?
      )
    `,
  ).run(id, nextTitle, projectId ?? null, now, now);

  return {
    id,
    title: nextTitle,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    latestMessagePreview: null,
    latestMessageAt: null,
    projectId: projectId ?? null,
    projectName: projectId ? getProjectDirectory(projectId).name : null,
    projectPath: projectId ? getProjectDirectory(projectId).path : null,
    projectKind: projectId ? getProjectDirectory(projectId).kind : null,
  };
}

export function setSessionProjectBinding(sessionId: string, projectId: string | null) {
  const session = getSessionRow(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  if (projectId) {
    getProjectDirectory(projectId);
  }

  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `
      UPDATE sessions
      SET project_id = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(projectId, now, sessionId);

  return getSessionProjectBinding(sessionId);
}

export function deleteSession(sessionId: string) {
  const existing = getSessionRow(sessionId);
  if (!existing) {
    return null;
  }

  const binding = getSessionProjectBinding(sessionId);
  if (binding?.projectPath) {
    clearSessionTranscriptExports(binding.projectPath, sessionId);
    pruneEmptyTranscriptParents(binding.projectPath);
  }

  const db = getDatabase();
  db.prepare(
    `
      DELETE FROM sessions
      WHERE id = ?
    `,
  ).run(sessionId);

  return {
    id: existing.id,
    title: existing.title,
  };
}

function getMessageByClientMessageId(sessionId: string, clientMessageId: string): SessionMessage | null {
  const db = getDatabase();
  const attachments = listAttachments(sessionId);
  const row = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          client_message_id AS clientMessageId,
          role,
          content,
          attachment_ids AS attachmentIds,
          status,
          source_device_id AS sourceDeviceId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM session_messages
        WHERE session_id = ?
          AND client_message_id = ?
      `,
    )
    .get(sessionId, clientMessageId) as SessionMessageRow | undefined;

  if (!row) {
    return null;
  }

  return toMessage(row, attachments);
}

function getMessageById(sessionId: string, messageId: string): SessionMessage | null {
  const db = getDatabase();
  const attachments = listAttachments(sessionId);
  const row = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          client_message_id AS clientMessageId,
          role,
          content,
          attachment_ids AS attachmentIds,
          status,
          source_device_id AS sourceDeviceId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM session_messages
        WHERE session_id = ?
          AND id = ?
      `,
    )
    .get(sessionId, messageId) as SessionMessageRow | undefined;

  if (!row) {
    return null;
  }

  return toMessage(row, attachments);
}

export function listSessionMessageReactions(sessionId: string, messageId: string) {
  if (!getMessageById(sessionId, messageId)) {
    throw new Error(`Message ${messageId} was not found in session ${sessionId}`);
  }

  return listMessageReactions(sessionId, messageId);
}

export function addSessionMessageReaction(input: {
  sessionId: string;
  messageId: string;
  emoji: string;
  deviceId: string;
}) {
  if (!getMessageById(input.sessionId, input.messageId)) {
    throw new Error(`Message ${input.messageId} was not found in session ${input.sessionId}`);
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const reactionId = randomUUID();

  const result = db.transaction(() => {
    const insert = db.prepare(
      `
        INSERT OR IGNORE INTO message_reactions (
          id, session_id, message_id, emoji, source_device_id, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(
      reactionId,
      input.sessionId,
      input.messageId,
      input.emoji,
      input.deviceId,
      now,
    );

    const reaction = db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            message_id AS messageId,
            emoji,
            source_device_id AS sourceDeviceId,
            created_at AS createdAt
          FROM message_reactions
          WHERE session_id = ?
            AND message_id = ?
            AND emoji = ?
            AND source_device_id = ?
        `,
      )
      .get(input.sessionId, input.messageId, input.emoji, input.deviceId) as MessageReactionRow | undefined;

    if (insert.changes > 0) {
      touchSession(input.sessionId, now);
    }

    return {
      created: insert.changes > 0,
      reaction: reaction ? toMessageReaction(reaction) : null,
      reactions: listMessageReactions(input.sessionId, input.messageId),
    };
  })();

  return result;
}

export function removeSessionMessageReaction(input: {
  sessionId: string;
  messageId: string;
  emoji: string;
  deviceId: string;
}) {
  if (!getMessageById(input.sessionId, input.messageId)) {
    throw new Error(`Message ${input.messageId} was not found in session ${input.sessionId}`);
  }

  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    const removal = db.prepare(
      `
        DELETE FROM message_reactions
        WHERE session_id = ?
          AND message_id = ?
          AND emoji = ?
          AND source_device_id = ?
      `,
    ).run(input.sessionId, input.messageId, input.emoji, input.deviceId);

    if (removal.changes > 0) {
      touchSession(input.sessionId, now);
    }

    return {
      removed: removal.changes > 0,
      reactions: listMessageReactions(input.sessionId, input.messageId),
    };
  })();

  return result;
}

function recordEvent(
  sessionId: string,
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
  createdAt: string,
): SessionEvent {
  const db = getDatabase();
  const eventId = randomUUID();
  db.prepare(
    `
      INSERT INTO session_events (
        id, session_id, type, payload, created_at
      ) VALUES (
        ?, ?, ?, ?, ?
      )
    `,
  ).run(eventId, sessionId, type, JSON.stringify(payload), createdAt);

  const row = db
    .prepare(
      `
        SELECT
          id,
          seq,
          session_id AS sessionId,
          type,
          payload,
          created_at AS createdAt
        FROM session_events
        WHERE id = ?
      `,
    )
    .get(eventId) as SessionEventRow;

  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.sessionId,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

function touchSession(sessionId: string, updatedAt: string) {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
}

function upsertJob(job: JobRunDetail) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO job_runs (
        id, session_id, kind, status, title, detail, updated_at
      ) VALUES (
        @id, @sessionId, @kind, @status, @title, @detail, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        detail = excluded.detail,
        updated_at = excluded.updated_at
    `,
  ).run(job);
}

interface PendingApprovalEventRow {
  sessionId: string;
  payload: string;
}

interface ApprovalEventRow {
  sessionId: string;
  payload: string;
}

function listPendingApprovalEvents(): ToolApproval[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          session_id AS sessionId,
          payload
        FROM session_events
        WHERE type IN ('tool.approval.requested', 'tool.approval.resolved')
        ORDER BY seq ASC
      `,
    )
    .all() as PendingApprovalEventRow[];

  const approvals = new Map<string, ToolApproval>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { approval?: ToolApproval };
    const approval = payload.approval;
    if (!approval) {
      continue;
    }

    approvals.set(approval.id, {
      ...approval,
      sessionId: row.sessionId,
    });
  }

  return [...approvals.values()].filter((approval) => approval.status === "pending");
}

function listResolvedApprovalEvents(sessionId: string): ToolApproval[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          session_id AS sessionId,
          payload
        FROM session_events
        WHERE session_id = ?
          AND type = 'tool.approval.resolved'
        ORDER BY seq ASC
      `,
    )
    .all(sessionId) as ApprovalEventRow[];

  const approvals = new Map<string, ToolApproval>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { approval?: ToolApproval };
    const approval = payload.approval;
    if (!approval || approval.status === "pending") {
      continue;
    }

    approvals.set(approval.id, {
      ...approval,
      sessionId: row.sessionId,
    });
  }

  return [...approvals.values()].sort((left, right) => {
    const leftTime = left.resolvedAt ?? left.requestedAt;
    const rightTime = right.resolvedAt ?? right.requestedAt;
    return leftTime.localeCompare(rightTime);
  });
}

export function reconcileInterruptedSessionState() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const runningJobs = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          kind,
          status,
          title,
          detail,
          updated_at AS updatedAt
        FROM job_runs
        WHERE kind = 'provider-completion'
          AND status = 'running'
      `,
    )
    .all() as JobRunRow[];
  const pendingApprovals = listPendingApprovalEvents();

  if (runningJobs.length === 0 && pendingApprovals.length === 0) {
    return {
      clearedJobs: 0,
      clearedApprovals: 0,
    };
  }

  db.transaction(() => {
    for (const row of runningJobs) {
      const job: JobRunDetail = {
        id: row.id,
        sessionId: row.sessionId,
        kind: row.kind,
        status: "failed",
        title: "Agent interrupted",
        detail: "Daemon restarted before this response completed. Please retry the request.",
        updatedAt: now,
      };
      upsertJob(job);
      syncTaskRunFromJob(job);
      touchSession(job.sessionId, now);
      recordEvent(job.sessionId, "job.updated", { job }, now);
    }

    for (const approval of pendingApprovals) {
      const resolvedApproval: ToolApproval = {
        ...approval,
        status: "rejected",
        resolvedAt: now,
      };
      touchSession(approval.sessionId, now);
      recordEvent(approval.sessionId, "tool.approval.resolved", {
        approval: resolvedApproval,
      }, now);
    }
  })();

  return {
    clearedJobs: runningJobs.length,
    clearedApprovals: pendingApprovals.length,
  };
}

export function upsertSessionJob(input: UpsertJobInput): {
  job: JobRunDetail;
  event: SessionEvent;
} {
  const now = new Date().toISOString();
  const job: JobRunDetail = {
    ...input,
    updatedAt: now,
  };

  const db = getDatabase();
  const result = db.transaction(() => {
    upsertJob(job);
    syncTaskRunFromJob(job);
    touchSession(input.sessionId, now);
    const event = recordEvent(input.sessionId, "job.updated", { job }, now);
    return { job, event };
  })();

  return result;
}

export function recordArtifactEvent(
  sessionId: string,
  type: Extract<
    SessionEvent["type"],
    "artifact.created" | "artifact.block.created" | "artifact.block.append" | "artifact.done" | "artifact.updated"
  >,
  payload: Record<string, unknown>,
  createdAt: string,
) {
  const db = getDatabase();
  return db.transaction(() => {
    touchSession(sessionId, createdAt);
    return recordEvent(sessionId, type, payload, createdAt);
  })();
}

export function recordArtifactUpdate(sessionId: string, artifact: StudyArtifact) {
  return recordArtifactEvent(sessionId, "artifact.updated", { artifact }, artifact.updatedAt);
}

export function appendSessionEvent(
  sessionId: string,
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
  createdAt = new Date().toISOString(),
) {
  const db = getDatabase();
  return db.transaction(() => {
    touchSession(sessionId, createdAt);
    return recordEvent(sessionId, type, payload, createdAt);
  })();
}

export function getSessionSnapshot(sessionId: string): SessionSnapshot {
  const session = getSessionRow(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  const project = getSessionProjectBinding(sessionId);
  const attachments = listAttachments(sessionId);
  const messages = listMessages(sessionId, attachments);
  const jobs = listJobs(sessionId);
  const devices = listDevices();
  const runtimePresence = buildRuntimePresence(devices);
  const db = getDatabase();
  const lastEvent = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?")
    .get(sessionId) as { seq: number };
  const overview = getShellOverview();

  return {
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      projectId: project?.projectId ?? null,
      projectName: project?.projectName ?? null,
      projectPath: project?.projectPath ?? null,
      projectKind: project?.projectKind ?? null,
    },
    project,
    messages,
    attachments,
    pendingToolApprovals: listPendingToolApprovals(sessionId),
    resolvedToolApprovals: listResolvedApprovalEvents(sessionId),
    jobs,
    devices,
    runtimePresence,
    artifacts: overview.artifacts,
    overview,
    lastEventSeq: lastEvent.seq,
  };
}

export function listSessionAttachmentSandboxRoots(sessionId: string) {
  const project = getSessionProjectBinding(sessionId);
  const attachments = listAttachments(sessionId);
  return buildSessionAttachmentSandboxRoots(project, attachments);
}

export function listSessionEventsSince(sessionId: string, sinceSeq: number): SessionEvent[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          seq,
          session_id AS sessionId,
          type,
          payload,
          created_at AS createdAt
        FROM session_events
        WHERE session_id = ?
          AND seq > ?
        ORDER BY seq ASC
      `,
    )
    .all(sessionId, sinceSeq) as SessionEventRow[];

  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    sessionId: row.sessionId,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.createdAt,
  }));
}

export function getRuntimePresence(): RuntimePresence {
  return buildRuntimePresence(listDevices());
}

export function canAcceptClientTraffic(deviceType: DeviceType) {
  return deviceType === "desktop" || getRuntimePresence().online;
}

export function createSessionMessage(input: CreateMessageInput): {
  created: boolean;
  message: SessionMessage;
  events: SessionEvent[];
} {
  const existing = getMessageByClientMessageId(input.sessionId, input.clientMessageId);
  if (existing) {
    return {
      created: false,
      message: existing,
      events: [],
    };
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const messageId = randomUUID();
  const createdMessage: SessionMessage = {
    id: messageId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    role: input.role,
    content: input.content,
    attachments: listAttachments(input.sessionId).filter((attachment) => input.attachmentIds.includes(attachment.id)),
    status: "pending",
    createdAt: now,
  };

  const insert = db.transaction(() => {
    const session = getSessionRow(input.sessionId);
    const shouldRetitleSession =
      input.role === "user" &&
      Boolean(input.content.trim()) &&
      Boolean(session?.title.startsWith("新对话")) &&
      countMessagesForSession(input.sessionId) === 0;

    db.prepare(
      `
        INSERT INTO session_messages (
          id, session_id, client_message_id, role, content, attachment_ids, status, source_device_id, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(
      createdMessage.id,
      createdMessage.sessionId,
      createdMessage.clientMessageId,
      createdMessage.role,
      createdMessage.content,
      JSON.stringify(input.attachmentIds),
      createdMessage.status,
      input.deviceId,
      createdMessage.createdAt,
      createdMessage.createdAt,
    );

    if (shouldRetitleSession) {
      db.prepare(
        `
          UPDATE sessions
          SET title = ?, updated_at = ?
          WHERE id = ?
        `,
      ).run(summarizeSessionTitle(input.content), now, input.sessionId);
    }

    touchSession(input.sessionId, now);
    const createdEvent = recordEvent(input.sessionId, "message.created", {
      message: createdMessage,
      ...(input.eventPayload ?? {}),
    }, now);

    const ackedMessage: SessionMessage = {
      ...createdMessage,
      status: "acked",
    };

    db.prepare(
      `
        UPDATE session_messages
        SET status = ?, updated_at = ?
        WHERE id = ?
      `,
    ).run(ackedMessage.status, now, createdMessage.id);

    const ackedEvent = recordEvent(input.sessionId, "message.acked", {
      message: ackedMessage,
      ...(input.eventPayload ?? {}),
    }, now);

    return {
      message: ackedMessage,
      events: [createdEvent, ackedEvent],
    };
  });

  const result = insert();

  return {
    created: true,
    message: result.message,
    events: result.events,
  };
}

export function updateSessionMessage(input: {
  sessionId: string;
  messageId: string;
  content: string;
  status?: SessionMessageStatus;
  eventPayload?: Record<string, unknown>;
}): {
  message: SessionMessage;
  event: SessionEvent;
} {
  const existing = getMessageById(input.sessionId, input.messageId);
  if (!existing) {
    throw new Error(`Message ${input.messageId} was not found in session ${input.sessionId}`);
  }

  const now = new Date().toISOString();
  const nextMessage: SessionMessage = {
    ...existing,
    content: input.content,
    status: input.status ?? existing.status,
  };

  const db = getDatabase();
  const result = db.transaction(() => {
    db.prepare(
      `
        UPDATE session_messages
        SET content = ?, status = ?, updated_at = ?
        WHERE id = ?
      `,
    ).run(nextMessage.content, nextMessage.status, now, input.messageId);

    touchSession(input.sessionId, now);
    const event = recordEvent(input.sessionId, "message.updated", {
      message: nextMessage,
      ...(input.eventPayload ?? {}),
    }, now);
    return { message: nextMessage, event };
  })();

  return result;
}

export function createAttachment(input: CreateAttachmentInput): {
  attachment: Attachment;
  jobs: JobRunDetail[];
  events: SessionEvent[];
} {
  const db = getDatabase();
  const attachmentId = randomUUID();
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const attachment: Attachment = {
    id: attachmentId,
    sessionId: input.sessionId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    storagePath: input.storagePath,
    originalPath: input.originalPath,
    status: "ready",
    createdAt: now,
  };

  const jobs: JobRunDetail[] = [
    {
      id: jobId,
      sessionId: input.sessionId,
      kind: "attachment-ingest",
      status: "queued",
      title: `接收附件 · ${input.fileName}`,
      detail: "附件已入队，等待本机 runtime 处理。",
      updatedAt: now,
    },
    {
      id: jobId,
      sessionId: input.sessionId,
      kind: "attachment-ingest",
      status: "running",
      title: `解析附件 · ${input.fileName}`,
      detail: "正在更新会话附件和同步流。",
      updatedAt: now,
    },
    {
      id: jobId,
      sessionId: input.sessionId,
      kind: "attachment-ingest",
      status: "done",
      title: `附件已就绪 · ${input.fileName}`,
      detail: "可以继续把这份图片或文件挂到消息里触发后续任务。",
      updatedAt: now,
    },
  ];

  const insert = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO attachments (
          id, session_id, file_name, mime_type, byte_size, storage_path, original_path, status, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(
      attachment.id,
      attachment.sessionId,
      attachment.fileName,
      attachment.mimeType,
      attachment.byteSize,
      attachment.storagePath,
      attachment.originalPath ?? null,
      attachment.status,
      attachment.createdAt,
    );

    touchSession(input.sessionId, now);

    const events: SessionEvent[] = [recordEvent(input.sessionId, "attachment.ready", { attachment }, now)];

    for (const job of jobs) {
      upsertJob(job);
      syncTaskRunFromJob(job);
      events.push(recordEvent(input.sessionId, "job.updated", { job }, now));
    }

    return events;
  });

  return {
    attachment,
    jobs,
    events: insert(),
  };
}

export function heartbeatDevice(input: HeartbeatInput): {
  devices: DevicePresence[];
  runtimePresence: RuntimePresence;
  event: SessionEvent;
} {
  const db = getDatabase();
  const now = new Date().toISOString();

  const update = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO device_presence (
          device_id, device_type, label, status, last_seen_at, capabilities_json
        ) VALUES (
          ?, ?, ?, 'online', ?, ?
        )
        ON CONFLICT(device_id) DO UPDATE SET
          device_type = excluded.device_type,
          label = excluded.label,
          status = 'online',
          last_seen_at = excluded.last_seen_at,
          capabilities_json = excluded.capabilities_json
      `,
    ).run(
      input.deviceId,
      input.deviceType,
      input.label,
      now,
      JSON.stringify(input.capabilities ?? {}),
    );

    const devices = listDevices(new Date(now).getTime());
    const runtimePresence = buildRuntimePresence(devices);
    const eventType = runtimePresence.online ? "presence.updated" : "runtime.offline";
    const event = recordEvent(input.sessionId, eventType, { devices, runtimePresence }, now);

    return {
      devices,
      runtimePresence,
      event,
    };
  });

  return update();
}
