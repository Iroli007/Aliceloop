import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProviderKind,
  previewSessionSnapshot,
  previewShellOverview,
  type AttentionEvent,
  type DevicePresence,
  type JobRunDetail,
  type LibraryItem,
  type MemoryNote,
  type Session,
  type SessionEvent,
  type SessionMessage,
  type StudyArtifact,
  type TaskRun,
} from "@aliceloop/runtime-core";
import { schemaStatements } from "./schema";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ALICELOOP_DATA_DIR?.trim()
  ? resolve(process.env.ALICELOOP_DATA_DIR)
  : join(currentDir, "../../.data");
const uploadsDir = join(dataDir, "uploads");
const databasePath = join(dataDir, "aliceloop.db");

type SeedContentBlock = {
  id: string;
  libraryItemId: string;
  sectionKey: string;
  sectionLabel: string;
  pageFrom: number;
  pageTo: number;
  blockKind: string;
  content: string;
};

type SeedCrossReference = {
  id: string;
  sourceKind: string;
  sourceRef: string;
  targetKind: string;
  targetRef: string;
  label: string;
  score: number;
};

type SeedProviderConfig = {
  providerId: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  enabled: number;
  updatedAt: string;
};

const seedContentBlocks: SeedContentBlock[] = [
  {
    id: "block-outline-bianzheng",
    libraryItemId: "book-bianzheng",
    sectionKey: "chapter-03",
    sectionLabel: "第三章 八纲辨证",
    pageFrom: 28,
    pageTo: 35,
    blockKind: "outline",
    content: "八纲辨证从阴阳、表里、寒热、虚实四对维度组织，是定位整本书核心导航的上层框架。",
  },
  {
    id: "block-body-bianzheng",
    libraryItemId: "book-bianzheng",
    sectionKey: "chapter-03.section-02",
    sectionLabel: "八纲辨证 · 寒热",
    pageFrom: 31,
    pageTo: 32,
    blockKind: "paragraph",
    content: "寒证常见畏寒喜暖、口淡不渴、舌淡苔白。热证常见口渴喜冷饮、面赤、舌红苔黄。气虚与阳虚容易在此处发生混淆。",
  },
  {
    id: "block-figure-bianzheng",
    libraryItemId: "book-bianzheng",
    sectionKey: "chapter-03.figure-01",
    sectionLabel: "八纲辨证关系图",
    pageFrom: 33,
    pageTo: 33,
    blockKind: "figure-caption",
    content: "本图对表里、寒热、虚实之间的组合关系进行总览，适合作为回忆入口而不是逐句阅读。",
  },
];

const seedCrossReferences: SeedCrossReference[] = [
  {
    id: "xref-cold-heat-figure",
    sourceKind: "concept",
    sourceRef: "寒热",
    targetKind: "content-block",
    targetRef: "block-figure-bianzheng",
    label: "寒热判断关系图",
    score: 0.93,
  },
  {
    id: "xref-qi-yang",
    sourceKind: "concept",
    sourceRef: "气虚-阳虚",
    targetKind: "content-block",
    targetRef: "block-body-bianzheng",
    label: "混淆点回链到正文",
    score: 0.95,
  },
];

const previewEvents: SessionEvent[] = [
  {
    id: "seed-session-event-1",
    sessionId: previewSessionSnapshot.session.id,
    seq: 1,
    type: "message.created",
    payload: {
      message: previewSessionSnapshot.messages[0],
    },
    createdAt: previewSessionSnapshot.messages[0].createdAt,
  },
  {
    id: "seed-session-event-2",
    sessionId: previewSessionSnapshot.session.id,
    seq: 2,
    type: "message.acked",
    payload: {
      message: previewSessionSnapshot.messages[1],
    },
    createdAt: previewSessionSnapshot.messages[1].createdAt,
  },
  {
    id: "seed-session-event-3",
    sessionId: previewSessionSnapshot.session.id,
    seq: 3,
    type: "attachment.ready",
    payload: {
      attachment: previewSessionSnapshot.attachments[0],
    },
    createdAt: previewSessionSnapshot.attachments[0].createdAt,
  },
  {
    id: "seed-session-event-4",
    sessionId: previewSessionSnapshot.session.id,
    seq: 4,
    type: "message.created",
    payload: {
      message: previewSessionSnapshot.messages[2],
    },
    createdAt: previewSessionSnapshot.messages[2].createdAt,
  },
  {
    id: "seed-session-event-5",
    sessionId: previewSessionSnapshot.session.id,
    seq: 5,
    type: "job.updated",
    payload: {
      job: previewSessionSnapshot.jobs[0],
    },
    createdAt: previewSessionSnapshot.jobs[0].updatedAt,
  },
  {
    id: "seed-session-event-6",
    sessionId: previewSessionSnapshot.session.id,
    seq: 6,
    type: "presence.updated",
    payload: {
      devices: previewSessionSnapshot.devices,
      runtimePresence: previewSessionSnapshot.runtimePresence,
    },
    createdAt: previewSessionSnapshot.runtimePresence.lastHeartbeatAt ?? previewSessionSnapshot.session.updatedAt,
  },
];

const seedProviderConfigs: SeedProviderConfig[] = [
  {
    providerId: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M2.1",
    apiKey: null,
    enabled: 0,
    updatedAt: previewSessionSnapshot.session.updatedAt,
  },
];

function seedLibraryItem(db: Database.Database, item: LibraryItem) {
  db.prepare(
    `
      INSERT OR REPLACE INTO library_items (
        id, title, source_kind, document_kind, source_path, created_at, updated_at, last_attention_label
      ) VALUES (
        @id, @title, @sourceKind, @documentKind, @sourcePath, @createdAt, @updatedAt, @lastAttentionLabel
      )
    `,
  ).run(item);
}

function seedArtifact(db: Database.Database, artifact: StudyArtifact) {
  db.prepare(
    `
      INSERT OR REPLACE INTO study_artifacts (
        id, library_item_id, kind, title, summary, body, related_library_title, updated_at_label, updated_at
      ) VALUES (
        @id, @libraryItemId, @kind, @title, @summary, @body, @relatedLibraryTitle, @updatedAtLabel, @updatedAt
      )
    `,
  ).run(artifact);
}

function seedTaskRun(db: Database.Database, taskRun: TaskRun) {
  db.prepare(
    `
      INSERT OR REPLACE INTO task_runs (
        id, session_id, task_type, status, title, detail, updated_at, updated_at_label
      ) VALUES (
        @id, @sessionId, @taskType, @status, @title, @detail, @updatedAt, @updatedAtLabel
      )
    `,
  ).run(taskRun);
}

function seedAttentionEvent(db: Database.Database, event: AttentionEvent) {
  db.prepare(
    `
      INSERT OR REPLACE INTO attention_events (
        id, library_item_id, section_key, concept_key, reason, weight, occurred_at
      ) VALUES (
        @id, @libraryItemId, @sectionKey, @conceptKey, @reason, @weight, @occurredAt
      )
    `,
  ).run(event);
}

function seedMemory(db: Database.Database, memory: MemoryNote) {
  db.prepare(
    `
      INSERT OR REPLACE INTO memory_notes (
        id, kind, title, content, source, updated_at
      ) VALUES (
        @id, @kind, @title, @content, @source, @updatedAt
      )
    `,
  ).run(memory);
}

function seedFtsBlock(db: Database.Database, block: SeedContentBlock) {
  db.prepare(
    `
      INSERT OR REPLACE INTO content_blocks (
        id, library_item_id, section_key, section_label, page_from, page_to, block_kind, content
      ) VALUES (
        @id, @libraryItemId, @sectionKey, @sectionLabel, @pageFrom, @pageTo, @blockKind, @content
      )
    `,
  ).run(block);

  db.prepare(
    `
      INSERT OR REPLACE INTO content_blocks_fts (
        rowid, content_block_id, library_item_id, section_key, content
      ) VALUES (
        (SELECT rowid FROM content_blocks_fts WHERE content_block_id = @id),
        @id,
        @libraryItemId,
        @sectionKey,
        @content
      )
    `,
  ).run(block);
}

function seedCrossReference(db: Database.Database, crossReference: SeedCrossReference) {
  db.prepare(
    `
      INSERT OR REPLACE INTO cross_references (
        id, source_kind, source_ref, target_kind, target_ref, label, score
      ) VALUES (
        @id, @sourceKind, @sourceRef, @targetKind, @targetRef, @label, @score
      )
    `,
  ).run(crossReference);
}

function seedSession(db: Database.Database, session: Session) {
  db.prepare(
    `
      INSERT OR REPLACE INTO sessions (
        id, title, created_at, updated_at
      ) VALUES (
        @id, @title, @createdAt, @updatedAt
      )
    `,
  ).run(session);
}

function seedAttachment(db: Database.Database, attachment: SessionMessage["attachments"][number]) {
  db.prepare(
    `
      INSERT OR REPLACE INTO attachments (
        id, session_id, file_name, mime_type, byte_size, storage_path, status, created_at
      ) VALUES (
        @id, @sessionId, @fileName, @mimeType, @byteSize, @storagePath, @status, @createdAt
      )
    `,
  ).run(attachment);
}

function seedSessionMessage(db: Database.Database, message: SessionMessage, sourceDeviceId: string) {
  db.prepare(
    `
      INSERT OR REPLACE INTO session_messages (
        id, session_id, client_message_id, role, content, attachment_ids, status, source_device_id, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @clientMessageId, @role, @content, @attachmentIds, @status, @sourceDeviceId, @createdAt, @updatedAt
      )
    `,
  ).run({
    ...message,
    attachmentIds: JSON.stringify(message.attachments.map((attachment) => attachment.id)),
    sourceDeviceId,
    updatedAt: message.createdAt,
  });
}

function seedSessionEvent(db: Database.Database, event: SessionEvent) {
  db.prepare(
    `
      INSERT OR REPLACE INTO session_events (
        seq, id, session_id, type, payload, created_at
      ) VALUES (
        @seq, @id, @sessionId, @type, @payload, @createdAt
      )
    `,
  ).run({
    ...event,
    payload: JSON.stringify(event.payload),
  });
}

function seedDevicePresence(db: Database.Database, device: DevicePresence) {
  db.prepare(
    `
      INSERT OR REPLACE INTO device_presence (
        device_id, device_type, label, status, last_seen_at
      ) VALUES (
        @deviceId, @deviceType, @label, @status, @lastSeenAt
      )
    `,
  ).run(device);
}

function seedJobRun(db: Database.Database, job: JobRunDetail) {
  db.prepare(
    `
      INSERT OR REPLACE INTO job_runs (
        id, session_id, kind, status, title, detail, updated_at
      ) VALUES (
        @id, @sessionId, @kind, @status, @title, @detail, @updatedAt
      )
    `,
  ).run(job);
}

function seedProviderConfig(db: Database.Database, config: SeedProviderConfig) {
  db.prepare(
    `
      INSERT OR IGNORE INTO provider_configs (
        provider_id, label, base_url, model, api_key, enabled, updated_at
      ) VALUES (
        @providerId, @label, @baseUrl, @model, @apiKey, @enabled, @updatedAt
      )
    `,
  ).run(config);
}

function seedOverviewData(db: Database.Database) {
  const recordCount = db.prepare("SELECT COUNT(*) AS count FROM library_items").get() as { count: number };
  if (recordCount.count > 0) {
    return;
  }

  for (const item of previewShellOverview.library) {
    seedLibraryItem(db, item);
  }

  for (const artifact of previewShellOverview.artifacts) {
    seedArtifact(db, artifact);
  }

  for (const taskRun of previewShellOverview.taskRuns) {
    seedTaskRun(db, taskRun);
  }

  db.prepare(
    `
      INSERT OR REPLACE INTO attention_state (
        id, current_library_item_id, current_library_title, current_section_key, current_section_label, focus_summary, concepts, updated_at
      ) VALUES (
        @id, @currentLibraryItemId, @currentLibraryTitle, @currentSectionKey, @currentSectionLabel, @focusSummary, @concepts, @updatedAt
      )
    `,
  ).run({
    id: "primary",
    currentLibraryItemId: previewShellOverview.attention.currentLibraryItemId,
    currentLibraryTitle: previewShellOverview.attention.currentLibraryTitle,
    currentSectionKey: previewShellOverview.attention.currentSectionKey,
    currentSectionLabel: previewShellOverview.attention.currentSectionLabel,
    focusSummary: previewShellOverview.attention.focusSummary,
    concepts: JSON.stringify(previewShellOverview.attention.concepts),
    updatedAt: previewShellOverview.attention.updatedAt,
  });

  for (const event of previewShellOverview.attention.events) {
    seedAttentionEvent(db, event);
  }

  for (const memory of previewShellOverview.memories) {
    seedMemory(db, memory);
  }

  for (const block of seedContentBlocks) {
    seedFtsBlock(db, block);
  }

  for (const crossReference of seedCrossReferences) {
    seedCrossReference(db, crossReference);
  }
}

function seedSessionData(db: Database.Database) {
  const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
  if (sessionCount.count > 0) {
    return;
  }

  seedSession(db, previewSessionSnapshot.session);

  for (const attachment of previewSessionSnapshot.attachments) {
    seedAttachment(db, attachment);
  }

  seedSessionMessage(db, previewSessionSnapshot.messages[0], "desktop-preview");
  seedSessionMessage(db, previewSessionSnapshot.messages[1], "desktop-preview");
  seedSessionMessage(db, previewSessionSnapshot.messages[2], "mobile-preview");

  for (const device of previewSessionSnapshot.devices) {
    seedDevicePresence(db, device);
  }

  for (const job of previewSessionSnapshot.jobs) {
    seedJobRun(db, job);
  }

  for (const event of previewEvents) {
    seedSessionEvent(db, event);
  }
}

function seedProviderData(db: Database.Database) {
  for (const config of seedProviderConfigs) {
    seedProviderConfig(db, config);
  }
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function runMigrations(db: Database.Database) {
  ensureColumn(db, "study_artifacts", "body", "TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE study_artifacts SET body = summary WHERE COALESCE(body, '') = ''").run();
  ensureColumn(db, "task_runs", "session_id", "TEXT");
  ensureColumn(db, "task_runs", "detail", "TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE task_runs SET detail = title WHERE COALESCE(detail, '') = ''").run();
}

function bootstrap(db: Database.Database) {
  for (const statement of schemaStatements) {
    db.exec(statement);
  }

  runMigrations(db);
  seedProviderData(db);
  seedOverviewData(db);
  seedSessionData(db);
}

let database: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  bootstrap(database);
  return database;
}

export function getUploadsDir() {
  mkdirSync(uploadsDir, { recursive: true });
  return uploadsDir;
}
