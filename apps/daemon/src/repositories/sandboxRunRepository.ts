import type { SandboxPrimitive, SandboxRun, SandboxRunStatus } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

interface SandboxRunRow {
  id: string;
  primitive: SandboxPrimitive;
  status: SandboxRunStatus;
  targetPath: string | null;
  command: string | null;
  argsJson: string;
  cwd: string | null;
  detail: string;
  createdAt: string;
  finishedAt: string | null;
}

interface CreateSandboxRunInput {
  id: string;
  primitive: SandboxPrimitive;
  status: SandboxRunStatus;
  targetPath?: string | null;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  detail: string;
  createdAt: string;
  finishedAt?: string | null;
}

function toSandboxRun(row: SandboxRunRow): SandboxRun {
  return {
    id: row.id,
    primitive: row.primitive,
    status: row.status,
    targetPath: row.targetPath,
    command: row.command,
    args: JSON.parse(row.argsJson) as string[],
    cwd: row.cwd,
    detail: row.detail,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function createSandboxRun(input: CreateSandboxRunInput): SandboxRun {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO sandbox_runs (
        id, primitive, status, target_path, command, args_json, cwd, detail, created_at, finished_at
      ) VALUES (
        @id, @primitive, @status, @targetPath, @command, @argsJson, @cwd, @detail, @createdAt, @finishedAt
      )
    `,
  ).run({
    ...input,
    targetPath: input.targetPath ?? null,
    command: input.command ?? null,
    argsJson: JSON.stringify(input.args ?? []),
    cwd: input.cwd ?? null,
    finishedAt: input.finishedAt ?? null,
  });

  return getSandboxRun(input.id) as SandboxRun;
}

export function finishSandboxRun(
  id: string,
  input: {
    status: SandboxRunStatus;
    detail: string;
    finishedAt?: string | null;
  },
) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE sandbox_runs
      SET status = ?, detail = ?, finished_at = ?
      WHERE id = ?
    `,
  ).run(input.status, input.detail, input.finishedAt ?? new Date().toISOString(), id);

  return getSandboxRun(id);
}

export function getSandboxRun(id: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          primitive,
          status,
          target_path AS targetPath,
          command,
          args_json AS argsJson,
          cwd,
          detail,
          created_at AS createdAt,
          finished_at AS finishedAt
        FROM sandbox_runs
        WHERE id = ?
      `,
    )
    .get(id) as SandboxRunRow | undefined;

  return row ? toSandboxRun(row) : null;
}

export function listSandboxRuns(limit = 50) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          primitive,
          status,
          target_path AS targetPath,
          command,
          args_json AS argsJson,
          cwd,
          detail,
          created_at AS createdAt,
          finished_at AS finishedAt
        FROM sandbox_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
    )
    .all(Math.max(1, Math.min(limit, 200))) as SandboxRunRow[];

  return rows.map(toSandboxRun);
}
