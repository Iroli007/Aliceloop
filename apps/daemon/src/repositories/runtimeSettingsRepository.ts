import {
  defaultRuntimeSettings,
  normalizeAutoApproveToolRequests,
  normalizeReasoningEffort,
  normalizeSandboxPermissionProfile,
  type ReasoningEffort,
  type RuntimeSettings,
  type SandboxPermissionProfile,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

const runtimeSettingsId = "primary";
let runtimeSettingsCache: RuntimeSettings | null = null;
let runtimeSettingsEnsured = false;

interface RuntimeSettingsRow {
  sandboxProfile: string;
  autoApproveToolRequests: string | number | boolean | null;
  reasoningEffort: string;
  updatedAt: string;
}

function ensureRuntimeSettingsRow() {
  if (runtimeSettingsEnsured) {
    return;
  }

  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT OR IGNORE INTO runtime_settings (
        id, sandbox_profile, auto_approve_tool_requests, reasoning_effort, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?
      )
    `,
  ).run(
    runtimeSettingsId,
    defaultRuntimeSettings.sandboxProfile,
    defaultRuntimeSettings.autoApproveToolRequests ? 1 : 0,
    defaultRuntimeSettings.reasoningEffort,
    now,
  );
  runtimeSettingsEnsured = true;
}

export function getRuntimeSettings(): RuntimeSettings {
  if (runtimeSettingsCache) {
    return { ...runtimeSettingsCache };
  }

  ensureRuntimeSettingsRow();
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          sandbox_profile AS sandboxProfile,
          auto_approve_tool_requests AS autoApproveToolRequests,
          reasoning_effort AS reasoningEffort,
          updated_at AS updatedAt
        FROM runtime_settings
        WHERE id = ?
      `,
    )
    .get(runtimeSettingsId) as RuntimeSettingsRow | undefined;

  if (!row) {
    runtimeSettingsCache = { ...defaultRuntimeSettings };
    return { ...defaultRuntimeSettings };
  }

  runtimeSettingsCache = {
    sandboxProfile: normalizeSandboxPermissionProfile(row.sandboxProfile),
    autoApproveToolRequests: normalizeAutoApproveToolRequests(row.autoApproveToolRequests),
    reasoningEffort: normalizeReasoningEffort(row.reasoningEffort),
    updatedAt: row.updatedAt,
  };

  return { ...runtimeSettingsCache };
}

export function updateRuntimeSettings(input: {
  sandboxProfile?: SandboxPermissionProfile;
  autoApproveToolRequests?: boolean;
  reasoningEffort?: ReasoningEffort;
}): RuntimeSettings {
  const current = getRuntimeSettings();
  const next: RuntimeSettings = {
    sandboxProfile: normalizeSandboxPermissionProfile(input.sandboxProfile ?? current.sandboxProfile),
    autoApproveToolRequests: input.autoApproveToolRequests ?? current.autoApproveToolRequests,
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort ?? current.reasoningEffort),
    updatedAt: new Date().toISOString(),
  };
  const db = getDatabase();

  db.prepare(
    `
      INSERT INTO runtime_settings (
        id, sandbox_profile, auto_approve_tool_requests, reasoning_effort, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        sandbox_profile = excluded.sandbox_profile,
        auto_approve_tool_requests = excluded.auto_approve_tool_requests,
        reasoning_effort = excluded.reasoning_effort,
        updated_at = excluded.updated_at
    `,
  ).run(
    runtimeSettingsId,
    next.sandboxProfile,
    next.autoApproveToolRequests ? 1 : 0,
    next.reasoningEffort,
    next.updatedAt,
  );

  runtimeSettingsCache = next;
  runtimeSettingsEnsured = true;
  return { ...next };
}

export function resetRuntimeSettingsCache() {
  runtimeSettingsCache = null;
  runtimeSettingsEnsured = false;
}
