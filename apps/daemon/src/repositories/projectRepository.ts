import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ProjectDirectory,
  type ProjectDirectoryKind,
} from "@aliceloop/runtime-core";
import { getDataDir, getDatabase } from "../db/client";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  kind: ProjectDirectoryKind;
  isDefault: number;
  sessionCount?: number;
  createdAt: string;
  updatedAt: string;
}

function getBuiltInProjectDefinitions() {
  const workspacesRoot = join(getDataDir(), "workspaces");
  return [
    {
      id: "workspace-default",
      name: "Default",
      path: join(workspacesRoot, "default"),
      kind: "workspace" as const,
      isDefault: 1,
    },
    {
      id: "workspace-temp",
      name: "Temp Session",
      path: join(workspacesRoot, "temp"),
      kind: "temporary" as const,
      isDefault: 0,
    },
  ];
}

export class ProjectDirectoryNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = "ProjectDirectoryNotFoundError";
  }
}

export class ProjectDirectoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDirectoryValidationError";
  }
}

export class ProjectDirectoryInUseError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} is still bound to one or more sessions`);
    this.name = "ProjectDirectoryInUseError";
  }
}

function toProjectDirectory(row: ProjectRow): ProjectDirectory {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    kind: row.kind,
    isDefault: Boolean(row.isDefault),
    sessionCount: row.sessionCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function expandHomePath(targetPath: string) {
  return targetPath.startsWith("~/")
    ? join(homedir(), targetPath.slice(2))
    : targetPath;
}

export function normalizeProjectDirectoryPath(targetPath: string) {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new ProjectDirectoryValidationError("project_path_required");
  }

  return resolve(expandHomePath(trimmed));
}

function normalizeProjectDirectoryName(name: string | undefined, fallbackPath: string) {
  const trimmed = name?.trim();
  if (trimmed) {
    return trimmed;
  }

  const fallbackName = basename(fallbackPath).trim();
  if (fallbackName) {
    return fallbackName;
  }

  throw new ProjectDirectoryValidationError("project_name_required");
}

function ensureProjectDirectoryExists(targetPath: string) {
  mkdirSync(targetPath, { recursive: true });
}

function getProjectRow(projectId: string): ProjectRow | undefined {
  const db = getDatabase();
  return db.prepare(
    `
      SELECT
        id,
        name,
        path,
        kind,
        is_default AS isDefault,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM projects
      WHERE id = ?
    `,
  ).get(projectId) as ProjectRow | undefined;
}

function getProjectRowByPath(projectPath: string): ProjectRow | undefined {
  const db = getDatabase();
  return db.prepare(
    `
      SELECT
        id,
        name,
        path,
        kind,
        is_default AS isDefault,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM projects
      WHERE path = ?
    `,
  ).get(projectPath) as ProjectRow | undefined;
}

function getWorkspaceFallbackProjectId(excludingProjectId: string) {
  const db = getDatabase();
  const row = db.prepare(
    `
      SELECT id
      FROM projects
      WHERE kind = 'workspace'
        AND id <> ?
      ORDER BY is_default DESC, updated_at DESC, created_at DESC
      LIMIT 1
    `,
  ).get(excludingProjectId) as { id: string } | undefined;

  return row?.id ?? null;
}

function setDefaultWorkspaceProject(projectId: string) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE projects
      SET is_default = CASE
        WHEN id = ? THEN 1
        ELSE 0
      END,
      updated_at = CASE
        WHEN id = ? THEN ?
        ELSE updated_at
      END
      WHERE kind = 'workspace'
    `,
  ).run(projectId, projectId, new Date().toISOString());
}

function ensureProjectDirectoriesSeeded() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const builtIns = getBuiltInProjectDefinitions();

  db.transaction(() => {
    for (const project of builtIns) {
      const existing = getProjectRow(project.id);
      if (existing) {
        ensureProjectDirectoryExists(existing.path);
        continue;
      }

      ensureProjectDirectoryExists(project.path);
      db.prepare(
        `
          INSERT INTO projects (
            id, name, path, kind, is_default, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?
          )
        `,
      ).run(project.id, project.name, project.path, project.kind, project.isDefault, now, now);
    }

    const hasWorkspaceDefault = db.prepare(
      `
        SELECT 1
        FROM projects
        WHERE kind = 'workspace'
          AND is_default = 1
        LIMIT 1
      `,
    ).get() as { 1: number } | undefined;

    if (!hasWorkspaceDefault) {
      const fallback = db.prepare(
        `
          SELECT id
          FROM projects
          WHERE kind = 'workspace'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `,
      ).get() as { id: string } | undefined;

      if (fallback) {
        db.prepare(
          `
            UPDATE projects
            SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END
            WHERE kind = 'workspace'
          `,
        ).run(fallback.id);
      }
    }
  })();
}

export function listProjectDirectories(): ProjectDirectory[] {
  ensureProjectDirectoriesSeeded();
  const db = getDatabase();
  const rows = db.prepare(
    `
      SELECT
        projects.id AS id,
        projects.name AS name,
        projects.path AS path,
        projects.kind AS kind,
        projects.is_default AS isDefault,
        projects.created_at AS createdAt,
        projects.updated_at AS updatedAt,
        COALESCE(session_counts.sessionCount, 0) AS sessionCount
      FROM projects
      LEFT JOIN (
        SELECT
          project_id,
          COUNT(*) AS sessionCount
        FROM sessions
        WHERE project_id IS NOT NULL
        GROUP BY project_id
      ) AS session_counts
        ON session_counts.project_id = projects.id
      ORDER BY
        CASE projects.kind
          WHEN 'workspace' THEN 0
          ELSE 1
        END ASC,
        projects.is_default DESC,
        projects.updated_at DESC,
        projects.created_at DESC
    `,
  ).all() as ProjectRow[];

  return rows.map(toProjectDirectory);
}

export function getProjectDirectory(projectId: string): ProjectDirectory {
  ensureProjectDirectoriesSeeded();
  const row = getProjectRow(projectId);
  if (!row) {
    throw new ProjectDirectoryNotFoundError(projectId);
  }

  const db = getDatabase();
  const count = db.prepare(
    `
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE project_id = ?
    `,
  ).get(projectId) as { count: number };

  return toProjectDirectory({
    ...row,
    sessionCount: count.count,
  });
}

export function getDefaultProjectDirectory(): ProjectDirectory {
  ensureProjectDirectoriesSeeded();
  const db = getDatabase();
  const row = db.prepare(
    `
      SELECT
        id,
        name,
        path,
        kind,
        is_default AS isDefault,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM projects
      WHERE kind = 'workspace'
        AND is_default = 1
      LIMIT 1
    `,
  ).get() as ProjectRow | undefined;

  if (!row) {
    throw new ProjectDirectoryValidationError("default_workspace_project_missing");
  }

  return toProjectDirectory(row);
}

export function listProjectDirectorySessionIds(projectId: string) {
  ensureProjectDirectoriesSeeded();
  const db = getDatabase();
  const rows = db.prepare(
    `
      SELECT id
      FROM sessions
      WHERE project_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `,
  ).all(projectId) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export function createProjectDirectory(input: {
  name?: string;
  path: string;
  kind?: ProjectDirectoryKind;
  isDefault?: boolean;
}) {
  ensureProjectDirectoriesSeeded();

  const kind = input.kind ?? "workspace";
  const normalizedPath = normalizeProjectDirectoryPath(input.path);
  const name = normalizeProjectDirectoryName(input.name, normalizedPath);
  if (kind === "temporary" && input.isDefault) {
    throw new ProjectDirectoryValidationError("temporary_project_cannot_be_default");
  }

  const existingByPath = getProjectRowByPath(normalizedPath);
  if (existingByPath) {
    throw new ProjectDirectoryValidationError("project_path_already_exists");
  }

  ensureProjectDirectoryExists(normalizedPath);

  const db = getDatabase();
  const now = new Date().toISOString();
  const projectId = randomUUID();

  db.transaction(() => {
    db.prepare(
      `
        INSERT INTO projects (
          id, name, path, kind, is_default, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(projectId, name, normalizedPath, kind, 0, now, now);

    const shouldBeDefault = kind === "workspace" && (
      input.isDefault === true
      || !db.prepare(
        `
          SELECT 1
          FROM projects
          WHERE kind = 'workspace'
            AND is_default = 1
            AND id <> ?
          LIMIT 1
        `,
      ).get(projectId)
    );

    if (shouldBeDefault) {
      setDefaultWorkspaceProject(projectId);
    }
  })();

  return getProjectDirectory(projectId);
}

export function updateProjectDirectory(input: {
  id: string;
  name?: string;
  path?: string;
  isDefault?: boolean;
}) {
  ensureProjectDirectoriesSeeded();
  const existing = getProjectRow(input.id);
  if (!existing) {
    throw new ProjectDirectoryNotFoundError(input.id);
  }

  if (existing.kind === "temporary" && input.isDefault) {
    throw new ProjectDirectoryValidationError("temporary_project_cannot_be_default");
  }

  const nextPath = input.path ? normalizeProjectDirectoryPath(input.path) : existing.path;
  const nextName = input.name !== undefined
    ? normalizeProjectDirectoryName(input.name, nextPath)
    : existing.name;

  const existingByPath = getProjectRowByPath(nextPath);
  if (existingByPath && existingByPath.id !== input.id) {
    throw new ProjectDirectoryValidationError("project_path_already_exists");
  }

  ensureProjectDirectoryExists(nextPath);

  const fallbackDefaultProjectId = input.isDefault === false && existing.isDefault
    ? getWorkspaceFallbackProjectId(existing.id)
    : null;
  if (input.isDefault === false && existing.isDefault && !fallbackDefaultProjectId) {
    throw new ProjectDirectoryValidationError("default_workspace_project_required");
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `
        UPDATE projects
        SET name = ?, path = ?, updated_at = ?
        WHERE id = ?
      `,
    ).run(nextName, nextPath, now, input.id);

    if (existing.kind === "workspace") {
      if (input.isDefault === true) {
        setDefaultWorkspaceProject(input.id);
      } else if (input.isDefault === false && fallbackDefaultProjectId) {
        setDefaultWorkspaceProject(fallbackDefaultProjectId);
      }
    }
  })();

  return {
    project: getProjectDirectory(input.id),
    previousPath: existing.path,
  };
}

export function deleteProjectDirectory(projectId: string) {
  ensureProjectDirectoriesSeeded();
  const existing = getProjectRow(projectId);
  if (!existing) {
    throw new ProjectDirectoryNotFoundError(projectId);
  }

  const sessionIds = listProjectDirectorySessionIds(projectId);
  if (sessionIds.length > 0) {
    throw new ProjectDirectoryInUseError(projectId);
  }

  const fallbackDefaultProjectId = existing.kind === "workspace" && existing.isDefault
    ? getWorkspaceFallbackProjectId(existing.id)
    : null;
  if (existing.kind === "workspace" && existing.isDefault && !fallbackDefaultProjectId) {
    throw new ProjectDirectoryValidationError("default_workspace_project_required");
  }

  const db = getDatabase();
  db.transaction(() => {
    db.prepare(
      `
        DELETE FROM projects
        WHERE id = ?
      `,
    ).run(projectId);

    if (fallbackDefaultProjectId) {
      setDefaultWorkspaceProject(fallbackDefaultProjectId);
    }
  })();

  return {
    id: existing.id,
    name: existing.name,
    path: existing.path,
  };
}
