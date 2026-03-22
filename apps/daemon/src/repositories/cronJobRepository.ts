import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";

export type CronJobStatus = "active" | "paused" | "completed";

type CronSchedule =
  | {
      kind: "interval";
      everySeconds: number;
      label: string;
    }
  | {
      kind: "daily";
      hour: number;
      minute: number;
      label: string;
    }
  | {
      kind: "weekly";
      weekday: number;
      hour: number;
      minute: number;
      label: string;
    }
  | {
      kind: "once";
      runAt: string;
      label: string;
    };

interface CronJobRow {
  id: string;
  name: string;
  scheduleType: CronSchedule["kind"];
  scheduleConfig: string;
  scheduleLabel: string;
  prompt: string;
  sessionId: string | null;
  status: CronJobStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface CreateCronJobInput {
  name: string;
  schedule: string;
  prompt: string;
  sessionId?: string | null;
}

interface CompleteCronJobRunInput {
  jobId: string;
  runAt?: string;
  sessionId?: string | null;
}

interface FailCronJobRunInput extends CompleteCronJobRunInput {
  errorMessage: string;
}

export interface CronJobRecord {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  sessionId: string | null;
  status: CronJobStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

const weekdayMap: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function padTwo(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeScheduleInput(input: string) {
  return input.trim().replace(/\s+/g, " ");
}

function parseHourMinute(hourToken: string, minuteToken: string) {
  const hour = Number(hourToken);
  const minute = Number(minuteToken);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("invalid_cron_schedule");
  }

  return {
    hour,
    minute,
  };
}

function serializeScheduleConfig(schedule: CronSchedule) {
  switch (schedule.kind) {
    case "interval":
      return JSON.stringify({ everySeconds: schedule.everySeconds });
    case "daily":
      return JSON.stringify({ hour: schedule.hour, minute: schedule.minute });
    case "weekly":
      return JSON.stringify({ weekday: schedule.weekday, hour: schedule.hour, minute: schedule.minute });
    case "once":
      return JSON.stringify({ runAt: schedule.runAt });
    default:
      return JSON.stringify({});
  }
}

function parseStoredSchedule(kind: CronSchedule["kind"], config: string, label: string): CronSchedule {
  const parsed = JSON.parse(config) as Record<string, unknown>;
  switch (kind) {
    case "interval":
      return {
        kind,
        everySeconds: Number(parsed.everySeconds),
        label,
      };
    case "daily":
      return {
        kind,
        hour: Number(parsed.hour),
        minute: Number(parsed.minute),
        label,
      };
    case "weekly":
      return {
        kind,
        weekday: Number(parsed.weekday),
        hour: Number(parsed.hour),
        minute: Number(parsed.minute),
        label,
      };
    case "once":
      return {
        kind,
        runAt: String(parsed.runAt),
        label,
      };
  }
}

function toCronJobRecord(row: CronJobRow): CronJobRecord {
  return {
    id: row.id,
    name: row.name,
    schedule: row.scheduleLabel,
    prompt: row.prompt,
    sessionId: row.sessionId,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
  };
}

function getScheduleLabel(schedule: CronSchedule) {
  return schedule.label;
}

function computeNextRunAt(schedule: CronSchedule, from: Date) {
  switch (schedule.kind) {
    case "interval":
      return new Date(from.getTime() + schedule.everySeconds * 1000);
    case "daily": {
      const next = new Date(from);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
    case "weekly": {
      const next = new Date(from);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      const deltaDays = (schedule.weekday - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + deltaDays);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 7);
      }
      return next;
    }
    case "once": {
      const target = new Date(schedule.runAt);
      if (Number.isNaN(target.getTime())) {
        throw new Error("invalid_cron_schedule");
      }
      return target.getTime() > from.getTime() ? target : null;
    }
  }
}

function getCronJobRow(jobId: string) {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          id,
          name,
          schedule_type AS scheduleType,
          schedule_config AS scheduleConfig,
          schedule_label AS scheduleLabel,
          prompt,
          session_id AS sessionId,
          status,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_run_at AS lastRunAt,
          next_run_at AS nextRunAt
        FROM cron_jobs
        WHERE id = ?
      `,
    )
    .get(jobId) as CronJobRow | undefined;
}

export function parseCronSchedule(input: string, now = new Date()): CronSchedule {
  const normalized = normalizeScheduleInput(input);
  if (!normalized) {
    throw new Error("cron_schedule_required");
  }

  const intervalMatch = normalized.match(
    /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i,
  );
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("invalid_cron_schedule");
    }

    const unitSeconds =
      unit.startsWith("s") ? 1 : unit.startsWith("m") ? 60 : unit.startsWith("h") ? 60 * 60 : 60 * 60 * 24;

    return {
      kind: "interval",
      everySeconds: amount * unitSeconds,
      label: `every ${amount}${unit.startsWith("s") ? "s" : unit.startsWith("m") ? "m" : unit.startsWith("h") ? "h" : "d"}`,
    };
  }

  const dailyMatch = normalized.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    const { hour, minute } = parseHourMinute(dailyMatch[1], dailyMatch[2]);
    return {
      kind: "daily",
      hour,
      minute,
      label: `daily ${padTwo(hour)}:${padTwo(minute)}`,
    };
  }

  const weeklyMatch = normalized.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/i);
  if (weeklyMatch) {
    const weekdayKey = weeklyMatch[1].toLowerCase();
    const { hour, minute } = parseHourMinute(weeklyMatch[2], weeklyMatch[3]);
    return {
      kind: "weekly",
      weekday: weekdayMap[weekdayKey],
      hour,
      minute,
      label: `weekly ${weekdayKey} ${padTwo(hour)}:${padTwo(minute)}`,
    };
  }

  const normalizedAbsolute = normalized.replace(" ", "T");
  const absoluteTime = new Date(normalizedAbsolute);
  if (!Number.isNaN(absoluteTime.getTime())) {
    if (absoluteTime.getTime() <= now.getTime()) {
      throw new Error("cron_schedule_in_past");
    }

    return {
      kind: "once",
      runAt: absoluteTime.toISOString(),
      label: absoluteTime.toISOString(),
    };
  }

  throw new Error("invalid_cron_schedule");
}

export function listCronJobs(): CronJobRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          name,
          schedule_type AS scheduleType,
          schedule_config AS scheduleConfig,
          schedule_label AS scheduleLabel,
          prompt,
          session_id AS sessionId,
          status,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_run_at AS lastRunAt,
          next_run_at AS nextRunAt
        FROM cron_jobs
        ORDER BY
          CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
          next_run_at ASC,
          created_at ASC
      `,
    )
    .all() as CronJobRow[];

  return rows.map(toCronJobRecord);
}

export function createCronJob(input: CreateCronJobInput): CronJobRecord {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) {
    throw new Error("cron_name_required");
  }

  if (!prompt) {
    throw new Error("cron_prompt_required");
  }

  const now = new Date();
  const schedule = parseCronSchedule(input.schedule, now);
  const nextRunAt = computeNextRunAt(schedule, now);
  if (!nextRunAt) {
    throw new Error("cron_schedule_in_past");
  }

  const record: CronJobRow = {
    id: randomUUID(),
    name,
    scheduleType: schedule.kind,
    scheduleConfig: serializeScheduleConfig(schedule),
    scheduleLabel: getScheduleLabel(schedule),
    prompt,
    sessionId: input.sessionId?.trim() || null,
    status: "active",
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: nextRunAt.toISOString(),
  };

  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO cron_jobs (
        id,
        name,
        schedule_type,
        schedule_config,
        schedule_label,
        prompt,
        session_id,
        status,
        last_error,
        created_at,
        updated_at,
        last_run_at,
        next_run_at
      ) VALUES (
        @id,
        @name,
        @scheduleType,
        @scheduleConfig,
        @scheduleLabel,
        @prompt,
        @sessionId,
        @status,
        @lastError,
        @createdAt,
        @updatedAt,
        @lastRunAt,
        @nextRunAt
      )
    `,
  ).run(record);

  return toCronJobRecord(record);
}

export function deleteCronJob(jobId: string) {
  const existing = getCronJobRow(jobId);
  if (!existing) {
    return null;
  }

  const db = getDatabase();
  db.prepare(
    `
      DELETE FROM cron_jobs
      WHERE id = ?
    `,
  ).run(jobId);

  return toCronJobRecord(existing);
}

export function listDueCronJobs(nowIso = new Date().toISOString(), limit = 20): CronJobRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          name,
          schedule_type AS scheduleType,
          schedule_config AS scheduleConfig,
          schedule_label AS scheduleLabel,
          prompt,
          session_id AS sessionId,
          status,
          last_error AS lastError,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_run_at AS lastRunAt,
          next_run_at AS nextRunAt
        FROM cron_jobs
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `,
    )
    .all(nowIso, limit) as CronJobRow[];

  return rows.map(toCronJobRecord);
}

function finalizeCronJobRun(input: {
  jobId: string;
  runAt?: string;
  sessionId?: string | null;
  lastError: string | null;
}) {
  const existing = getCronJobRow(input.jobId);
  if (!existing) {
    return null;
  }

  const runAt = input.runAt ?? new Date().toISOString();
  const schedule = parseStoredSchedule(existing.scheduleType, existing.scheduleConfig, existing.scheduleLabel);
  const nextRunAt = computeNextRunAt(schedule, new Date(runAt));
  const status: CronJobStatus = nextRunAt ? "active" : "completed";

  const db = getDatabase();
  db.prepare(
    `
      UPDATE cron_jobs
      SET
        session_id = ?,
        status = ?,
        last_error = ?,
        updated_at = ?,
        last_run_at = ?,
        next_run_at = ?
      WHERE id = ?
    `,
  ).run(
    input.sessionId ?? existing.sessionId,
    status,
    input.lastError,
    runAt,
    runAt,
    nextRunAt ? nextRunAt.toISOString() : null,
    input.jobId,
  );

  return toCronJobRecord({
    ...existing,
    sessionId: input.sessionId ?? existing.sessionId,
    status,
    lastError: input.lastError,
    updatedAt: runAt,
    lastRunAt: runAt,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
  });
}

export function completeCronJobRun(input: CompleteCronJobRunInput) {
  return finalizeCronJobRun({
    jobId: input.jobId,
    runAt: input.runAt,
    sessionId: input.sessionId,
    lastError: null,
  });
}

export function failCronJobRun(input: FailCronJobRunInput) {
  return finalizeCronJobRun({
    jobId: input.jobId,
    runAt: input.runAt,
    sessionId: input.sessionId,
    lastError: input.errorMessage.trim().slice(0, 500) || "unknown cron failure",
  });
}
