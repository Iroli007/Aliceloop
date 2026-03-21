import { defaultUserProfile, type UserProfile } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

const userProfileId = "primary";

interface UserProfileRow {
  displayName: string | null;
  preferredLanguage: string | null;
  timezone: string | null;
  codeStyle: string | null;
  notes: string | null;
  updatedAt: string;
}

function ensureUserProfileRow() {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT OR IGNORE INTO user_profile (
        id, display_name, preferred_language, timezone, code_style, notes, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
    `,
  ).run(
    userProfileId,
    defaultUserProfile.displayName,
    defaultUserProfile.preferredLanguage,
    defaultUserProfile.timezone,
    defaultUserProfile.codeStyle,
    defaultUserProfile.notes,
    now,
  );
}

export function getUserProfile(): UserProfile {
  ensureUserProfileRow();
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          display_name AS displayName,
          preferred_language AS preferredLanguage,
          timezone,
          code_style AS codeStyle,
          notes,
          updated_at AS updatedAt
        FROM user_profile
        WHERE id = ?
      `,
    )
    .get(userProfileId) as UserProfileRow | undefined;

  if (!row) {
    return { ...defaultUserProfile, updatedAt: new Date().toISOString() };
  }

  return {
    displayName: row.displayName,
    preferredLanguage: row.preferredLanguage,
    timezone: row.timezone,
    codeStyle: row.codeStyle,
    notes: row.notes,
    updatedAt: row.updatedAt,
  };
}

export function updateUserProfile(input: Partial<Omit<UserProfile, "updatedAt">>): UserProfile {
  const current = getUserProfile();
  const now = new Date().toISOString();
  const next: UserProfile = {
    displayName: input.displayName !== undefined ? input.displayName : current.displayName,
    preferredLanguage: input.preferredLanguage !== undefined ? input.preferredLanguage : current.preferredLanguage,
    timezone: input.timezone !== undefined ? input.timezone : current.timezone,
    codeStyle: input.codeStyle !== undefined ? input.codeStyle : current.codeStyle,
    notes: input.notes !== undefined ? input.notes : current.notes,
    updatedAt: now,
  };

  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO user_profile (
        id, display_name, preferred_language, timezone, code_style, notes, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        preferred_language = excluded.preferred_language,
        timezone = excluded.timezone,
        code_style = excluded.code_style,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `,
  ).run(
    userProfileId,
    next.displayName,
    next.preferredLanguage,
    next.timezone,
    next.codeStyle,
    next.notes,
    next.updatedAt,
  );

  return next;
}
