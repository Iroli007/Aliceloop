import { defaultRuntimeSettings, type RuntimeSettings, type SandboxPermissionProfile } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

const runtimeSettingsId = "primary";

interface RuntimeSettingsRow {
  sandboxProfile: SandboxPermissionProfile;
  updatedAt: string;
}

function ensureRuntimeSettingsRow() {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT OR IGNORE INTO runtime_settings (
        id, sandbox_profile, updated_at
      ) VALUES (
        ?, ?, ?
      )
    `,
  ).run(runtimeSettingsId, defaultRuntimeSettings.sandboxProfile, now);
}

export function getRuntimeSettings(): RuntimeSettings {
  ensureRuntimeSettingsRow();
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          sandbox_profile AS sandboxProfile,
          updated_at AS updatedAt
        FROM runtime_settings
        WHERE id = ?
      `,
    )
    .get(runtimeSettingsId) as RuntimeSettingsRow | undefined;

  if (!row) {
    return defaultRuntimeSettings;
  }

  return {
    sandboxProfile: row.sandboxProfile,
    updatedAt: row.updatedAt,
  };
}

export function updateRuntimeSettings(input: {
  sandboxProfile?: SandboxPermissionProfile;
}): RuntimeSettings {
  const current = getRuntimeSettings();
  const next: RuntimeSettings = {
    sandboxProfile: input.sandboxProfile ?? current.sandboxProfile,
    updatedAt: new Date().toISOString(),
  };
  const db = getDatabase();

  db.prepare(
    `
      INSERT INTO runtime_settings (
        id, sandbox_profile, updated_at
      ) VALUES (
        ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        sandbox_profile = excluded.sandbox_profile,
        updated_at = excluded.updated_at
    `,
  ).run(runtimeSettingsId, next.sandboxProfile, next.updatedAt);

  return next;
}
