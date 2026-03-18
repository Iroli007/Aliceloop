import {
  shellOverviewRoute,
  type AttentionEvent,
  type AttentionState,
  type LibraryItem,
  type MemoryNote,
  type ShellOverview,
  type StudyArtifact,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";
import { listTaskRuns } from "./taskRunRepository";

interface AttentionRow {
  id: string;
  current_library_item_id: string | null;
  current_library_title: string | null;
  current_section_key: string | null;
  current_section_label: string | null;
  focus_summary: string;
  concepts: string;
  updated_at: string;
}

export { shellOverviewRoute };

function getPrimaryLibrary() {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          id,
          title,
          source_kind AS sourceKind,
          document_kind AS documentKind,
          source_path AS sourcePath,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_attention_label AS lastAttentionLabel
        FROM library_items
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get() as LibraryItem | undefined;
}

export function getPrimaryLibraryContext() {
  const db = getDatabase();
  const attentionRow = db
    .prepare(
      `
        SELECT
          current_library_item_id AS currentLibraryItemId,
          current_library_title AS currentLibraryTitle
        FROM attention_state
        WHERE id = 'primary'
      `,
    )
    .get() as { currentLibraryItemId: string | null; currentLibraryTitle: string | null } | undefined;

  const library = getPrimaryLibrary();

  return {
    libraryItemId: attentionRow?.currentLibraryItemId ?? library?.id ?? "book-bianzheng",
    relatedLibraryTitle: attentionRow?.currentLibraryTitle ?? library?.title ?? "Aliceloop Study Library",
  };
}

export function upsertStudyArtifact(artifact: StudyArtifact) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO study_artifacts (
        id, library_item_id, kind, title, summary, body, related_library_title, updated_at_label, updated_at
      ) VALUES (
        @id, @libraryItemId, @kind, @title, @summary, @body, @relatedLibraryTitle, @updatedAtLabel, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        body = excluded.body,
        related_library_title = excluded.related_library_title,
        updated_at_label = excluded.updated_at_label,
        updated_at = excluded.updated_at
    `,
  ).run(artifact);

  return artifact;
}

export function getShellOverview(): ShellOverview {
  const db = getDatabase();

  const library = db
    .prepare(
      `
        SELECT
          id,
          title,
          source_kind AS sourceKind,
          document_kind AS documentKind,
          source_path AS sourcePath,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_attention_label AS lastAttentionLabel
        FROM library_items
        ORDER BY updated_at DESC
      `,
    )
    .all() as LibraryItem[];

  const artifacts = db
    .prepare(
      `
        SELECT
          id,
          library_item_id AS libraryItemId,
          kind,
          title,
          summary,
          body,
          related_library_title AS relatedLibraryTitle,
          updated_at AS updatedAt,
          updated_at_label AS updatedAtLabel
        FROM study_artifacts
        ORDER BY updated_at DESC
      `,
    )
    .all() as StudyArtifact[];

  const taskRuns = listTaskRuns({ limit: 100 });

  const memoryRows = db
    .prepare(
      `
        SELECT
          id,
          kind,
          title,
          content,
          source,
          updated_at AS updatedAt
        FROM memory_notes
        ORDER BY updated_at DESC
      `,
    )
    .all() as MemoryNote[];

  const attentionRow = db
    .prepare(
      `
        SELECT
          id,
          current_library_item_id,
          current_library_title,
          current_section_key,
          current_section_label,
          focus_summary,
          concepts,
          updated_at
        FROM attention_state
        WHERE id = 'primary'
      `,
    )
    .get() as AttentionRow;

  const attentionEvents = db
    .prepare(
      `
        SELECT
          id,
          library_item_id AS libraryItemId,
          section_key AS sectionKey,
          concept_key AS conceptKey,
          reason,
          weight,
          occurred_at AS occurredAt
        FROM attention_events
        ORDER BY occurred_at DESC
      `,
    )
    .all() as AttentionEvent[];

  const attention: AttentionState = {
    id: attentionRow.id,
    currentLibraryItemId: attentionRow.current_library_item_id,
    currentLibraryTitle: attentionRow.current_library_title,
    currentSectionKey: attentionRow.current_section_key,
    currentSectionLabel: attentionRow.current_section_label,
    focusSummary: attentionRow.focus_summary,
    concepts: JSON.parse(attentionRow.concepts) as string[],
    updatedAt: attentionRow.updated_at,
    events: attentionEvents,
  };

  return {
    attention,
    artifacts,
    library,
    memories: memoryRows,
    taskRuns,
  };
}
