import type { MemoryNote } from "@aliceloop/runtime-core";
import { getDatabase } from "../../db/client";

interface CreateMemoryNoteInput {
  id: string;
  kind: MemoryNote["kind"];
  title: string;
  content: string;
  source: string;
  updatedAt: string;
}

function getMemoryNoteById(memoryId: string) {
  const db = getDatabase();
  const row = db
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
        WHERE id = ?
      `,
    )
    .get(memoryId) as MemoryNote | undefined;

  return row ?? null;
}

function buildSearchContent(input: Pick<CreateMemoryNoteInput, "title" | "content">) {
  return `${input.title}\n${input.content}`.trim();
}

function syncMemorySearchIndex(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT rowid
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(input.id) as { rowid: number } | undefined;

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
    memoryId: input.id,
    kind: input.kind,
    content: buildSearchContent(input),
  });
}

function normalizeFtsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0)
    .map((term) => `${term}*`)
    .join(" ");
}

export function createMemoryNote(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO memory_notes (
        id, kind, title, content, source, updated_at
      ) VALUES (
        @id, @kind, @title, @content, @source, @updatedAt
      )
    `,
  ).run(input);
  syncMemorySearchIndex(input);

  const created = getMemoryNoteById(input.id);
  if (!created) {
    throw new Error(`Memory note ${input.id} was not created`);
  }

  return created;
}

export function upsertMemoryNote(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO memory_notes (
        id, kind, title, content, source, updated_at
      ) VALUES (
        @id, @kind, @title, @content, @source, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        source = excluded.source,
        updated_at = excluded.updated_at
    `,
  ).run(input);
  syncMemorySearchIndex(input);

  const updated = getMemoryNoteById(input.id);
  if (!updated) {
    throw new Error(`Memory note ${input.id} was not saved`);
  }

  return updated;
}

export function listMemoryNotes(limit = 50, source?: string) {
  const db = getDatabase();
  const normalizedLimit = Math.max(1, Math.min(limit, 200));

  if (source?.trim()) {
    return db
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
          WHERE source = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(source.trim(), normalizedLimit) as MemoryNote[];
  }

  return db
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
        LIMIT ?
      `,
    )
    .all(normalizedLimit) as MemoryNote[];
}

export function getMemoryNote(memoryId: string) {
  return getMemoryNoteById(memoryId);
}

export function deleteMemoryNote(memoryId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT rowid
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(memoryId) as { rowid: number } | undefined;

  if (!row) {
    return false;
  }

  db.prepare(
    `
      DELETE FROM memory_notes_fts
      WHERE rowid = ?
    `,
  ).run(row.rowid);

  const result = db
    .prepare(
      `
        DELETE FROM memory_notes
        WHERE id = ?
      `,
    )
    .run(memoryId);

  return result.changes > 0;
}

export function searchMemoryNotes(query: string, limit = 10, source?: string): MemoryNote[] {
  const db = getDatabase();
  const normalizedSource = source?.trim();

  const hasFts = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_notes_fts'`,
    )
    .get();

  if (hasFts && query.trim()) {
    const normalizedQuery = normalizeFtsQuery(query);
    if (normalizedQuery) {
      try {
        const ftsQuery = normalizedSource
          ? db
            .prepare(
              `
                SELECT
                  m.id,
                  m.kind,
                  m.title,
                  m.content,
                  m.source,
                  m.updated_at AS updatedAt
                FROM memory_notes_fts fts
                JOIN memory_notes m ON m.id = fts.memory_id
                WHERE memory_notes_fts MATCH ?
                  AND m.source = ?
                ORDER BY rank
                LIMIT ?
              `,
            )
            .all(normalizedQuery, normalizedSource, limit)
          : db
            .prepare(
              `
                SELECT
                  m.id,
                  m.kind,
                  m.title,
                  m.content,
                  m.source,
                  m.updated_at AS updatedAt
                FROM memory_notes_fts fts
                JOIN memory_notes m ON m.id = fts.memory_id
                WHERE memory_notes_fts MATCH ?
                ORDER BY rank
                LIMIT ?
              `,
            )
            .all(normalizedQuery, limit);

        const ftsResults = ftsQuery as MemoryNote[];

        if (ftsResults.length > 0) {
          return ftsResults;
        }
      } catch {
        // Fall back to LIKE search when the query cannot be parsed by FTS5.
      }
    }
  }

  if (!query.trim()) {
    return listMemoryNotes(limit, normalizedSource);
  }

  if (normalizedSource) {
    return db
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
          WHERE source = ?
            AND (content LIKE ? OR title LIKE ?)
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(normalizedSource, `%${query}%`, `%${query}%`, limit) as MemoryNote[];
  }

  return db
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
        WHERE content LIKE ? OR title LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(`%${query}%`, `%${query}%`, limit) as MemoryNote[];
}
