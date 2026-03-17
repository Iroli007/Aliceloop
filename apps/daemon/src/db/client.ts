import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  previewShellOverview,
  type AttentionEvent,
  type LibraryItem,
  type MemoryNote,
  type StudyArtifact,
  type TaskRun,
} from "@aliceloop/runtime-core";
import { schemaStatements } from "./schema";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(currentDir, "../../.data");
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
        id, library_item_id, kind, title, summary, related_library_title, updated_at_label, updated_at
      ) VALUES (
        @id, @libraryItemId, @kind, @title, @summary, @relatedLibraryTitle, @updatedAtLabel, @updatedAt
      )
    `,
  ).run(artifact);
}

function seedTaskRun(db: Database.Database, taskRun: TaskRun) {
  db.prepare(
    `
      INSERT OR REPLACE INTO task_runs (
        id, task_type, status, title, updated_at, updated_at_label
      ) VALUES (
        @id, @taskType, @status, @title, @updatedAt, @updatedAtLabel
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

function bootstrap(db: Database.Database) {
  for (const statement of schemaStatements) {
    db.exec(statement);
  }

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

let database: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  mkdirSync(dataDir, { recursive: true });
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  bootstrap(database);
  return database;
}
