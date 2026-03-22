import { resolve } from "node:path";
import { getDatabase } from "../db/client";

function normalizePath(targetPath: string) {
  return resolve(targetPath);
}

export function markSessionGeneratedFile(
  sessionId: string,
  targetPath: string,
  createdAt = new Date().toISOString(),
) {
  const db = getDatabase();
  const path = normalizePath(targetPath);
  db.prepare(
    `
      INSERT INTO session_generated_files (
        session_id, path, created_at, updated_at, deleted_at
      ) VALUES (
        ?, ?, ?, ?, NULL
      )
      ON CONFLICT(session_id, path) DO UPDATE SET
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `,
  ).run(sessionId, path, createdAt, createdAt);
}

export function isAliceloopGeneratedFile(targetPath: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT 1
        FROM session_generated_files
        WHERE path = ?
          AND deleted_at IS NULL
        LIMIT 1
      `,
    )
    .get(normalizePath(targetPath)) as { 1: number } | undefined;

  return Boolean(row);
}

export function markGeneratedFileDeleted(targetPath: string, deletedAt = new Date().toISOString()) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE session_generated_files
      SET updated_at = ?, deleted_at = ?
      WHERE path = ?
        AND deleted_at IS NULL
    `,
  ).run(deletedAt, deletedAt, normalizePath(targetPath));
}

export function listSessionGeneratedFiles(sessionId: string) {
  const db = getDatabase();
  const rows = db.prepare(
    `
      SELECT path
      FROM session_generated_files
      WHERE session_id = ?
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
    `,
  ).all(sessionId) as Array<{ path: string }>;

  return rows.map((row) => row.path);
}
