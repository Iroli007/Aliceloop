import {
  defaultRuntimeSettings,
  normalizeAutoApproveToolRequests,
  normalizeProviderKind,
  normalizeReasoningEffort,
  normalizeSandboxPermissionProfile,
  type ProviderKind,
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
  toolProviderId: string | null;
  toolModel: string | null;
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
        id, sandbox_profile, auto_approve_tool_requests, reasoning_effort, tool_provider_id, tool_model, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
    `,
  ).run(
    runtimeSettingsId,
    defaultRuntimeSettings.sandboxProfile,
    defaultRuntimeSettings.autoApproveToolRequests ? 1 : 0,
    defaultRuntimeSettings.reasoningEffort,
    defaultRuntimeSettings.toolProviderId,
    defaultRuntimeSettings.toolModel,
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
          tool_provider_id AS toolProviderId,
          tool_model AS toolModel,
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
    toolProviderId: normalizeProviderKind(row.toolProviderId),
    toolModel: row.toolModel?.trim() || null,
    updatedAt: row.updatedAt,
  };

  return { ...runtimeSettingsCache };
}

export function updateRuntimeSettings(input: {
  sandboxProfile?: SandboxPermissionProfile;
  autoApproveToolRequests?: boolean;
  reasoningEffort?: ReasoningEffort;
  toolProviderId?: ProviderKind | null;
  toolModel?: string | null;
}): RuntimeSettings {
  const current = getRuntimeSettings();
  const next: RuntimeSettings = {
    sandboxProfile: normalizeSandboxPermissionProfile(input.sandboxProfile ?? current.sandboxProfile),
    autoApproveToolRequests: input.autoApproveToolRequests ?? current.autoApproveToolRequests,
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort ?? current.reasoningEffort),
    toolProviderId: input.toolProviderId === undefined ? current.toolProviderId : normalizeProviderKind(input.toolProviderId),
    toolModel: input.toolModel === undefined ? current.toolModel : input.toolModel?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  const db = getDatabase();

  db.prepare(
    `
      INSERT INTO runtime_settings (
        id, sandbox_profile, auto_approve_tool_requests, reasoning_effort, tool_provider_id, tool_model, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        sandbox_profile = excluded.sandbox_profile,
        auto_approve_tool_requests = excluded.auto_approve_tool_requests,
        reasoning_effort = excluded.reasoning_effort,
        tool_provider_id = excluded.tool_provider_id,
        tool_model = excluded.tool_model,
        updated_at = excluded.updated_at
    `,
  ).run(
    runtimeSettingsId,
    next.sandboxProfile,
    next.autoApproveToolRequests ? 1 : 0,
    next.reasoningEffort,
    next.toolProviderId,
    next.toolModel,
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
