import { randomUUID } from "node:crypto";
import type {
  AttentionState,
  ContentBlock,
  CrossReference,
  DocumentStructure,
  LibraryItem,
  SectionSpan,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

interface DocumentStructureRow {
  id: string;
  libraryItemId: string;
  title: string;
  rootSectionKeys: string;
}

interface SectionSpanRow {
  sectionKey: string;
  title: string;
  pageFrom: number;
  pageTo: number;
  parentKey: string | null;
}

interface ContentBlockRow {
  id: string;
  libraryItemId: string;
  sectionKey: string;
  sectionLabel: string;
  pageFrom: number;
  pageTo: number;
  blockKind: ContentBlock["blockKind"];
  content: string;
}

interface CrossReferenceRow {
  id: string;
  sourceKind: string;
  sourceRef: string;
  targetKind: string;
  targetRef: string;
  label: string;
  score: number;
}

function toDocumentStructure(row: DocumentStructureRow): DocumentStructure {
  return {
    id: row.id,
    libraryItemId: row.libraryItemId,
    title: row.title,
    rootSectionKeys: JSON.parse(row.rootSectionKeys) as string[],
  };
}

function toSectionSpan(row: SectionSpanRow): SectionSpan {
  return {
    key: row.sectionKey,
    title: row.title,
    pageFrom: row.pageFrom,
    pageTo: row.pageTo,
    parentKey: row.parentKey,
  };
}

function toContentBlock(row: ContentBlockRow): ContentBlock {
  return {
    id: row.id,
    libraryItemId: row.libraryItemId,
    sectionKey: row.sectionKey,
    sectionLabel: row.sectionLabel,
    pageFrom: row.pageFrom,
    pageTo: row.pageTo,
    blockKind: row.blockKind,
    content: row.content,
  };
}

function toCrossReference(row: CrossReferenceRow): CrossReference {
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    label: row.label,
    score: row.score,
  };
}

export function listLibraryItems() {
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
        ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as LibraryItem[];
}

export function getDocumentStructure(libraryItemId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          library_item_id AS libraryItemId,
          title,
          root_section_keys AS rootSectionKeys
        FROM document_structures
        WHERE library_item_id = ?
      `,
    )
    .get(libraryItemId) as DocumentStructureRow | undefined;

  return row ? toDocumentStructure(row) : null;
}

export function listSectionSpans(libraryItemId: string) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          section_key AS sectionKey,
          title,
          page_from AS pageFrom,
          page_to AS pageTo,
          parent_key AS parentKey
        FROM section_spans
        WHERE library_item_id = ?
        ORDER BY order_index ASC, page_from ASC, section_key ASC
      `,
    )
    .all(libraryItemId) as SectionSpanRow[];

  return rows.map(toSectionSpan);
}

export function listContentBlocks(options: { libraryItemId: string; sectionKey?: string }) {
  const db = getDatabase();
  const rows = options.sectionKey
    ? (db
        .prepare(
          `
            SELECT
              id,
              library_item_id AS libraryItemId,
              section_key AS sectionKey,
              section_label AS sectionLabel,
              page_from AS pageFrom,
              page_to AS pageTo,
              block_kind AS blockKind,
              content
            FROM content_blocks
            WHERE library_item_id = ?
              AND section_key = ?
            ORDER BY page_from ASC, page_to ASC, id ASC
          `,
        )
        .all(options.libraryItemId, options.sectionKey) as ContentBlockRow[])
    : (db
        .prepare(
          `
            SELECT
              id,
              library_item_id AS libraryItemId,
              section_key AS sectionKey,
              section_label AS sectionLabel,
              page_from AS pageFrom,
              page_to AS pageTo,
              block_kind AS blockKind,
              content
            FROM content_blocks
            WHERE library_item_id = ?
            ORDER BY page_from ASC, page_to ASC, id ASC
          `,
        )
        .all(options.libraryItemId) as ContentBlockRow[]);

  return rows.map(toContentBlock);
}

export function searchContentBlocks(options: { query: string; libraryItemId?: string; limit?: number }) {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const rows = options.libraryItemId
    ? (db
        .prepare(
          `
            SELECT
              content_blocks.id AS id,
              content_blocks.library_item_id AS libraryItemId,
              content_blocks.section_key AS sectionKey,
              content_blocks.section_label AS sectionLabel,
              content_blocks.page_from AS pageFrom,
              content_blocks.page_to AS pageTo,
              content_blocks.block_kind AS blockKind,
              content_blocks.content AS content
            FROM content_blocks_fts
            JOIN content_blocks
              ON content_blocks.id = content_blocks_fts.content_block_id
            WHERE content_blocks_fts MATCH ?
              AND content_blocks.library_item_id = ?
            ORDER BY bm25(content_blocks_fts)
            LIMIT ?
          `,
        )
        .all(normalizedQuery, options.libraryItemId, limit) as ContentBlockRow[])
    : (db
        .prepare(
          `
            SELECT
              content_blocks.id AS id,
              content_blocks.library_item_id AS libraryItemId,
              content_blocks.section_key AS sectionKey,
              content_blocks.section_label AS sectionLabel,
              content_blocks.page_from AS pageFrom,
              content_blocks.page_to AS pageTo,
              content_blocks.block_kind AS blockKind,
              content_blocks.content AS content
            FROM content_blocks_fts
            JOIN content_blocks
              ON content_blocks.id = content_blocks_fts.content_block_id
            WHERE content_blocks_fts MATCH ?
            ORDER BY bm25(content_blocks_fts)
            LIMIT ?
          `,
        )
        .all(normalizedQuery, limit) as ContentBlockRow[]);

  if (rows.length > 0) {
    return rows.map(toContentBlock);
  }

  const likeQuery = `%${normalizedQuery}%`;
  const fallbackRows = options.libraryItemId
    ? (db
        .prepare(
          `
            SELECT
              id,
              library_item_id AS libraryItemId,
              section_key AS sectionKey,
              section_label AS sectionLabel,
              page_from AS pageFrom,
              page_to AS pageTo,
              block_kind AS blockKind,
              content
            FROM content_blocks
            WHERE library_item_id = ?
              AND content LIKE ?
            ORDER BY page_from ASC, page_to ASC, id ASC
            LIMIT ?
          `,
        )
        .all(options.libraryItemId, likeQuery, limit) as ContentBlockRow[])
    : (db
        .prepare(
          `
            SELECT
              id,
              library_item_id AS libraryItemId,
              section_key AS sectionKey,
              section_label AS sectionLabel,
              page_from AS pageFrom,
              page_to AS pageTo,
              block_kind AS blockKind,
              content
            FROM content_blocks
            WHERE content LIKE ?
            ORDER BY page_from ASC, page_to ASC, id ASC
            LIMIT ?
          `,
        )
        .all(likeQuery, limit) as ContentBlockRow[]);

  return fallbackRows.map(toContentBlock);
}

export function listCrossReferences(libraryItemId: string) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          cross_references.id AS id,
          cross_references.source_kind AS sourceKind,
          cross_references.source_ref AS sourceRef,
          cross_references.target_kind AS targetKind,
          cross_references.target_ref AS targetRef,
          cross_references.label AS label,
          cross_references.score AS score
        FROM cross_references
        JOIN content_blocks
          ON content_blocks.id = cross_references.target_ref
        WHERE content_blocks.library_item_id = ?
        ORDER BY cross_references.score DESC, cross_references.id ASC
      `,
    )
    .all(libraryItemId) as CrossReferenceRow[];

  return rows.map(toCrossReference);
}

export function persistIngestedLibrary(input: {
  libraryItem: LibraryItem;
  structure: DocumentStructure;
  sections: SectionSpan[];
  contentBlocks: ContentBlock[];
  crossReferences: CrossReference[];
}) {
  const db = getDatabase();

  db.transaction(() => {
    db.prepare(
      `
        INSERT INTO library_items (
          id, title, source_kind, document_kind, source_path, created_at, updated_at, last_attention_label
        ) VALUES (
          @id, @title, @sourceKind, @documentKind, @sourcePath, @createdAt, @updatedAt, @lastAttentionLabel
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          source_kind = excluded.source_kind,
          document_kind = excluded.document_kind,
          source_path = excluded.source_path,
          updated_at = excluded.updated_at,
          last_attention_label = excluded.last_attention_label
      `,
    ).run(input.libraryItem);

    db.prepare(
      `
        INSERT INTO document_structures (
          id, library_item_id, title, root_section_keys
        ) VALUES (
          @id, @libraryItemId, @title, @rootSectionKeys
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          root_section_keys = excluded.root_section_keys
      `,
    ).run({
      ...input.structure,
      rootSectionKeys: JSON.stringify(input.structure.rootSectionKeys),
    });

    const previousBlockIds = db
      .prepare(
        `
          SELECT id
          FROM content_blocks
          WHERE library_item_id = ?
        `,
      )
      .all(input.libraryItem.id) as Array<{ id: string }>;

    if (previousBlockIds.length > 0) {
      db.prepare(
        `
          DELETE FROM cross_references
          WHERE target_ref IN (${previousBlockIds.map(() => "?").join(",")})
        `,
      ).run(...previousBlockIds.map((row) => row.id));
    }

    db.prepare("DELETE FROM section_spans WHERE library_item_id = ?").run(input.libraryItem.id);
    db.prepare("DELETE FROM content_blocks_fts WHERE library_item_id = ?").run(input.libraryItem.id);
    db.prepare("DELETE FROM content_blocks WHERE library_item_id = ?").run(input.libraryItem.id);

    const insertSection = db.prepare(
      `
        INSERT INTO section_spans (
          id, library_item_id, section_key, title, page_from, page_to, parent_key, order_index
        ) VALUES (
          @id, @libraryItemId, @sectionKey, @title, @pageFrom, @pageTo, @parentKey, @orderIndex
        )
      `,
    );

    input.sections.forEach((section, index) => {
      insertSection.run({
        id: `${input.libraryItem.id}:${section.key}`,
        libraryItemId: input.libraryItem.id,
        sectionKey: section.key,
        title: section.title,
        pageFrom: section.pageFrom,
        pageTo: section.pageTo,
        parentKey: section.parentKey,
        orderIndex: index,
      });
    });

    const insertBlock = db.prepare(
      `
        INSERT INTO content_blocks (
          id, library_item_id, section_key, section_label, page_from, page_to, block_kind, content
        ) VALUES (
          @id, @libraryItemId, @sectionKey, @sectionLabel, @pageFrom, @pageTo, @blockKind, @content
        )
      `,
    );
    const insertFtsBlock = db.prepare(
      `
        INSERT INTO content_blocks_fts (
          content_block_id, library_item_id, section_key, content
        ) VALUES (
          @id, @libraryItemId, @sectionKey, @content
        )
      `,
    );

    for (const block of input.contentBlocks) {
      insertBlock.run(block);
      insertFtsBlock.run(block);
    }

    const insertCrossReference = db.prepare(
      `
        INSERT INTO cross_references (
          id, source_kind, source_ref, target_kind, target_ref, label, score
        ) VALUES (
          @id, @sourceKind, @sourceRef, @targetKind, @targetRef, @label, @score
        )
      `,
    );

    for (const crossReference of input.crossReferences) {
      insertCrossReference.run(crossReference);
    }
  })();

  return {
    structure: getDocumentStructure(input.libraryItem.id),
    sections: listSectionSpans(input.libraryItem.id),
    contentBlocks: listContentBlocks({ libraryItemId: input.libraryItem.id }),
    crossReferences: listCrossReferences(input.libraryItem.id),
  };
}

export function markLibraryAsFocused(input: {
  libraryItemId: string;
  libraryTitle: string;
  sectionKey: string | null;
  sectionLabel: string | null;
  focusSummary: string;
  concepts: string[];
}) {
  const db = getDatabase();
  const now = new Date().toISOString();

  const attentionState: AttentionState = {
    id: "primary",
    currentLibraryItemId: input.libraryItemId,
    currentLibraryTitle: input.libraryTitle,
    currentSectionKey: input.sectionKey,
    currentSectionLabel: input.sectionLabel,
    focusSummary: input.focusSummary,
    concepts: input.concepts,
    updatedAt: now,
    events: [],
  };

  db.transaction(() => {
    db.prepare(
      `
        INSERT INTO attention_state (
          id, current_library_item_id, current_library_title, current_section_key, current_section_label, focus_summary, concepts, updated_at
        ) VALUES (
          @id, @currentLibraryItemId, @currentLibraryTitle, @currentSectionKey, @currentSectionLabel, @focusSummary, @concepts, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          current_library_item_id = excluded.current_library_item_id,
          current_library_title = excluded.current_library_title,
          current_section_key = excluded.current_section_key,
          current_section_label = excluded.current_section_label,
          focus_summary = excluded.focus_summary,
          concepts = excluded.concepts,
          updated_at = excluded.updated_at
      `,
    ).run({
      ...attentionState,
      concepts: JSON.stringify(attentionState.concepts),
    });

    db.prepare(
      `
        INSERT INTO attention_events (
          id, library_item_id, section_key, concept_key, reason, weight, occurred_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(
      `attention-${randomUUID()}`,
      input.libraryItemId,
      input.sectionKey,
      input.concepts[0] ?? null,
      "document-ingest 完成后，将这份资料提升为当前关注资料。",
      0.9,
      now,
    );
  })();

  return attentionState;
}
