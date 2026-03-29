import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listProviderDefinitions,
  type ProviderKind,
  type ProviderTransportKind,
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
const DAEMON_PACKAGE_NAME = "@aliceloop/daemon";

function isDaemonPackageRoot(candidatePath: string) {
  const packageJsonPath = join(candidatePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === DAEMON_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function resolveDaemonPackageRoot(startPath: string) {
  let candidate = resolve(startPath);

  while (true) {
    if (isDaemonPackageRoot(candidate)) {
      return candidate;
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      return resolve(startPath, "../..");
    }

    candidate = parent;
  }
}

const daemonPackageRoot = resolveDaemonPackageRoot(currentDir);
const appsRoot = resolve(daemonPackageRoot, "..");
const dataDir = process.env.ALICELOOP_DATA_DIR?.trim()
  ? resolve(process.env.ALICELOOP_DATA_DIR)
  : join(appsRoot, ".data");
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
  transport: ProviderTransportKind;
  baseUrl: string;
  model: string;
  enabled: number;
  updatedAt: string;
};

const seedContentBlocks: SeedContentBlock[] = [
  {
    id: "block-outline-runtime",
    libraryItemId: "runtime-notes",
    sectionKey: "section-01",
    sectionLabel: "第 1 节 Runtime 概览",
    pageFrom: 28,
    pageTo: 35,
    blockKind: "outline",
    content: "Runtime 设计从 gateway、state plane、execution plane 和 skill layer 四个层级组织，是定位整套系统骨架的上层导航。",
  },
  {
    id: "block-body-runtime",
    libraryItemId: "runtime-notes",
    sectionKey: "section-03",
    sectionLabel: "第 3 节 Session Stream",
    pageFrom: 31,
    pageTo: 32,
    blockKind: "paragraph",
    content: "Session stream 负责把 snapshot、事件流和心跳串起来。真正的副作用执行不应该直接写进 UI，而应该先变成 typed commit 再落到 runtime core。",
  },
  {
    id: "block-figure-runtime",
    libraryItemId: "runtime-notes",
    sectionKey: "section-04.figure-01",
    sectionLabel: "Sandbox 边界图",
    pageFrom: 33,
    pageTo: 33,
    blockKind: "figure-caption",
    content: "本图对 read、grep、glob、write、edit、bash 六个原子命令的边界进行总览，适合作为回忆入口而不是逐句阅读。",
  },
];

const seedCrossReferences: SeedCrossReference[] = [
  {
    id: "xref-sandbox-figure",
    sourceKind: "concept",
    sourceRef: "sandbox",
    targetKind: "content-block",
    targetRef: "block-figure-runtime",
    label: "六原子边界图",
    score: 0.93,
  },
  {
    id: "xref-session-artifact",
    sourceKind: "concept",
    sourceRef: "session-artifact",
    targetKind: "content-block",
    targetRef: "block-body-runtime",
    label: "同步协议回链到正文",
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

const seedProviderConfigs: SeedProviderConfig[] = listProviderDefinitions().map((provider) => ({
  providerId: provider.id,
  label: provider.label,
  transport: provider.transport,
  baseUrl: provider.defaultBaseUrl,
  model: provider.defaultModel,
  enabled: 0,
  updatedAt: previewSessionSnapshot.session.updatedAt,
}));

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

  const row = db
    .prepare(
      `
        SELECT rowid
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(memory.id) as { rowid: number } | undefined;

  if (!row) {
    return;
  }

  db.prepare(
    `
      INSERT OR REPLACE INTO memory_notes_fts (
        rowid,
        memory_id,
        kind,
        content
      ) VALUES (
        @rowid,
        @memoryId,
        @kind,
        @content
      )
    `,
  ).run({
    rowid: row.rowid,
    memoryId: memory.id,
    kind: memory.kind,
    content: `${memory.title}\n${memory.content}`.trim(),
  });
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
        device_id, device_type, label, status, last_seen_at, capabilities_json
      ) VALUES (
        @deviceId, @deviceType, @label, @status, @lastSeenAt, @capabilitiesJson
      )
    `,
  ).run({
    ...device,
    capabilitiesJson: JSON.stringify(device.capabilities ?? {}),
  });
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
        provider_id, label, transport, base_url, model, api_key, enabled, updated_at
      ) VALUES (
        @providerId, @label, @transport, @baseUrl, @model, NULL, @enabled, @updatedAt
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
  ensureColumn(db, "sessions", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
  ensureColumn(db, "sessions", "workset_state_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "attachments", "original_path", "TEXT");
  ensureColumn(db, "study_artifacts", "body", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "provider_configs", "transport", "TEXT");
  db.prepare("UPDATE study_artifacts SET body = summary WHERE COALESCE(body, '') = ''").run();
  ensureColumn(db, "task_runs", "session_id", "TEXT");
  ensureColumn(db, "task_runs", "detail", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memories", "fact_kind", "TEXT CHECK(fact_kind IN ('preference', 'constraint', 'decision', 'profile', 'account', 'workflow', 'other'))");
  ensureColumn(db, "memories", "fact_key", "TEXT");
  ensureColumn(db, "memories", "fact_state", "TEXT NOT NULL DEFAULT 'active' CHECK(fact_state IN ('active', 'superseded', 'retracted'))");
  ensureColumn(db, "runtime_settings", "reasoning_effort", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn(db, "runtime_settings", "auto_approve_tool_requests", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "runtime_settings", "tool_provider_id", "TEXT");
  ensureColumn(db, "runtime_settings", "tool_model", "TEXT");
  ensureColumn(db, "device_presence", "capabilities_json", "TEXT NOT NULL DEFAULT '{}'");
  db.prepare("UPDATE runtime_settings SET reasoning_effort = 'medium' WHERE COALESCE(reasoning_effort, '') = ''").run();
  db.prepare("UPDATE task_runs SET detail = title WHERE COALESCE(detail, '') = ''").run();
  db.prepare("UPDATE memories SET fact_state = 'active' WHERE COALESCE(fact_state, '') = ''").run();
  db.prepare("UPDATE task_runs SET task_type = 'script-runner' WHERE task_type = 'local-script-runner'").run();
  db.prepare("UPDATE job_runs SET kind = 'script-runner' WHERE kind = 'local-script-runner'").run();
  db.prepare(
    `
      UPDATE library_items
      SET
        title = CASE id
          WHEN 'book-bianzheng' THEN 'Aliceloop Runtime Notes'
          WHEN 'book-fangji' THEN 'Session Sync Workshop'
          ELSE title
        END,
        source_path = CASE id
          WHEN 'book-bianzheng' THEN '/Library/Projects/Aliceloop/runtime-notes.md'
          WHEN 'book-fangji' THEN '/Library/Projects/Aliceloop/session-sync.pdf'
          ELSE source_path
        END,
        last_attention_label = CASE id
          WHEN 'book-bianzheng' THEN '第 3 节 · Session Stream'
          WHEN 'book-fangji' THEN '多端同步'
          ELSE last_attention_label
        END
      WHERE id IN ('book-bianzheng', 'book-fangji')
    `,
  ).run();
  db.prepare(
    `
      UPDATE study_artifacts
      SET
        title = CASE id
          WHEN 'artifact-study-bianzheng' THEN 'Runtime 结构整理页'
          WHEN 'artifact-review-pack' THEN '今晚复习包'
          ELSE title
        END,
        summary = CASE id
          WHEN 'artifact-study-bianzheng' THEN '聚焦 session、sandbox、artifact 和 memory 的关系，适合快速回看和后续实现前定位。'
          WHEN 'artifact-review-pack' THEN '围绕 runtime 分层、provider 接入和多端同步关系做抽问。'
          ELSE summary
        END,
        body = CASE id
          WHEN 'artifact-study-bianzheng' THEN '1. Session、queue 和 events 组成 runtime 的真相层，负责持续状态和多端同步。'||char(10)||'2. Sandbox 只提供 read、grep、glob、write、edit、bash 六个执行原子命令，skills 通过它做副作用操作。'||char(10)||'3. Artifact、memory 和 tasks 是提交层结果，不该和底层执行 ABI 混在一起。'
          WHEN 'artifact-review-pack' THEN '今晚先复习三件事：'||char(10)||'1. 先说清 gateway、runtime core 和 sandbox 各自负责什么。'||char(10)||'2. 回忆为什么 policy loop 不是 workflow，而是模型面对统一状态的下一跳决策。'||char(10)||'3. 再看一次多端同步链路，确认 snapshot、stream 和 heartbeat 的分工。'
          ELSE body
        END,
        related_library_title = 'Aliceloop Runtime Notes'
      WHERE id IN ('artifact-study-bianzheng', 'artifact-review-pack')
    `,
  ).run();
  db.prepare(
    `
      UPDATE memory_notes
      SET
        title = CASE id
          WHEN 'memory-1' THEN '近期关注重心'
          WHEN 'memory-2' THEN '稳定混淆点'
          ELSE title
        END,
        content = CASE id
          WHEN 'memory-1' THEN '用户最近主要围绕 runtime core、provider 接入和多端同步的边界来回切换。'
          WHEN 'memory-2' THEN '遇到 runtime 设计问题时，优先给分层图和最小执行边界，而不是先展开大而全的流程图。'
          ELSE content
        END
      WHERE id IN ('memory-1', 'memory-2')
    `,
  ).run();
  db.prepare(
    `
      UPDATE task_runs
      SET
        title = CASE id
          WHEN 'task-1' THEN '解析 Runtime 设计笔记目录与章节边界'
          WHEN 'task-2' THEN '生成 Runtime 结构整理页'
          ELSE title
        END,
        detail = CASE id
          WHEN 'task-1' THEN '目录、章节边界和首批导航块已经落到本地索引。'
          WHEN 'task-2' THEN '正在把 session、sandbox 和 artifact 的边界整理成可回看的结构化正文。'
          ELSE detail
        END
      WHERE id IN ('task-1', 'task-2')
    `,
  ).run();
  db.prepare(
    `
      UPDATE content_blocks
      SET
        section_label = CASE id
          WHEN 'block-outline-bianzheng' THEN '第 1 节 Runtime 概览'
          WHEN 'block-body-bianzheng' THEN '第 3 节 Session Stream'
          WHEN 'block-figure-bianzheng' THEN 'Sandbox 边界图'
          ELSE section_label
        END,
        content = CASE id
          WHEN 'block-outline-bianzheng' THEN 'Runtime 设计从 gateway、state plane、execution plane 和 skill layer 四个层级组织，是定位整套系统骨架的上层导航。'
          WHEN 'block-body-bianzheng' THEN 'Session stream 负责把 snapshot、事件流和心跳串起来。真正的副作用执行不应该直接写进 UI，而应该先变成 typed commit 再落到 runtime core。'
          WHEN 'block-figure-bianzheng' THEN '本图对 read、grep、glob、write、edit、bash 六个原子命令的边界进行总览，适合作为回忆入口而不是逐句阅读。'
          ELSE content
        END
      WHERE id IN ('block-outline-bianzheng', 'block-body-bianzheng', 'block-figure-bianzheng')
    `,
  ).run();
  db.prepare(
    `
      UPDATE content_blocks_fts
      SET content = (
        SELECT content FROM content_blocks WHERE content_blocks.id = content_blocks_fts.content_block_id
      )
      WHERE content_block_id IN ('block-outline-bianzheng', 'block-body-bianzheng', 'block-figure-bianzheng')
    `,
  ).run();
  db.prepare(
    `
      UPDATE cross_references
      SET
        source_ref = CASE id
          WHEN 'xref-cold-heat-figure' THEN 'sandbox'
          WHEN 'xref-qi-yang' THEN 'session-artifact'
          ELSE source_ref
        END,
        label = CASE id
          WHEN 'xref-cold-heat-figure' THEN '六原子边界图'
          WHEN 'xref-qi-yang' THEN '同步协议回链到正文'
          ELSE label
        END
      WHERE id IN ('xref-cold-heat-figure', 'xref-qi-yang')
    `,
  ).run();
  db.prepare(
    `
      UPDATE attention_state
      SET
        current_library_title = 'Aliceloop Runtime Notes',
        current_section_label = '第 3 节 · Session Stream',
        focus_summary = '最近连续回到 session stream、sandbox 边界和 artifact 提交这几个实现点。',
        concepts = '["session","sandbox","artifact","memory"]'
      WHERE id = 'primary' AND current_library_item_id = 'book-bianzheng'
    `,
  ).run();
  db.prepare(
    `
      UPDATE attention_events
      SET
        concept_key = CASE id
          WHEN 'event-1' THEN 'session-stream'
          WHEN 'event-2' THEN 'sandbox-boundary'
          ELSE concept_key
        END,
        reason = CASE id
          WHEN 'event-1' THEN '最近 24 小时反复回到同一段同步协议设计。'
          WHEN 'event-2' THEN '用户连续追问沙箱和 runtime core 的边界。'
          ELSE reason
        END
      WHERE id IN ('event-1', 'event-2')
    `,
  ).run();
  db.prepare("DELETE FROM memory_notes_fts").run();
  db.prepare(
    `
      INSERT INTO memory_notes_fts (
        rowid,
        memory_id,
        kind,
        content
      )
      SELECT
        rowid,
        id,
        kind,
        trim(title || char(10) || content)
      FROM memory_notes
    `,
  ).run();
}

function bootstrap(db: Database.Database) {
  const deferredStatements: string[] = [];
  for (const statement of schemaStatements) {
    try {
      db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("no such column:")
        && (
          statement.includes("project_id")
          || statement.includes("fact_state")
          || statement.includes("fact_kind")
          || statement.includes("fact_key")
        )
      ) {
        deferredStatements.push(statement);
        continue;
      }

      throw error;
    }
  }

  runMigrations(db);
  for (const statement of deferredStatements) {
    db.exec(statement);
  }
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

export function getDataDir() {
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getDatabasePath() {
  mkdirSync(dataDir, { recursive: true });
  return databasePath;
}
