import { type ProviderConfig, type ProviderKind } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

interface ProviderConfigRow {
  providerId: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  enabled: number;
  updatedAt: string;
}

interface UpdateProviderInput {
  providerId: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface StoredProviderConfig {
  id: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

const providerDefaults: Record<ProviderKind, StoredProviderConfig> = {
  minimax: {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.5",
    apiKey: null,
    enabled: false,
    updatedAt: null,
  },
};

function normalizeConfigText(value: string) {
  return value.trim().replace(/^[\s"'“”'`]+|[\s"'“”'`。；，、]+$/g, "");
}

function maskApiKey(apiKey: string | null) {
  if (!apiKey) {
    return null;
  }

  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}••••`;
  }

  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

function toStoredProviderConfig(row: ProviderConfigRow | undefined, providerId: ProviderKind): StoredProviderConfig {
  if (!row) {
    return providerDefaults[providerId];
  }

  return {
    id: row.providerId,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: row.apiKey,
    enabled: Boolean(row.enabled),
    updatedAt: row.updatedAt,
  };
}

function toPublicProviderConfig(config: StoredProviderConfig): ProviderConfig {
  return {
    id: config.id,
    label: config.label,
    baseUrl: config.baseUrl,
    model: config.model,
    enabled: config.enabled,
    hasApiKey: Boolean(config.apiKey),
    apiKeyMasked: maskApiKey(config.apiKey),
    updatedAt: config.updatedAt,
  };
}

function getProviderRow(providerId: ProviderKind) {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          provider_id AS providerId,
          label,
          base_url AS baseUrl,
          model,
          api_key AS apiKey,
          enabled,
          updated_at AS updatedAt
        FROM provider_configs
        WHERE provider_id = ?
      `,
    )
    .get(providerId) as ProviderConfigRow | undefined;
}

export function getProviderConfig(providerId: ProviderKind): ProviderConfig {
  return toPublicProviderConfig(toStoredProviderConfig(getProviderRow(providerId), providerId));
}

export function listProviderConfigs() {
  return (Object.keys(providerDefaults) as ProviderKind[]).map((providerId) => getProviderConfig(providerId));
}

export function getStoredProviderConfig(providerId: ProviderKind): StoredProviderConfig {
  return toStoredProviderConfig(getProviderRow(providerId), providerId);
}

export function getActiveProviderConfig() {
  return (Object.keys(providerDefaults) as ProviderKind[])
    .map((providerId) => getStoredProviderConfig(providerId))
    .find((provider) => provider.enabled && provider.apiKey)
    ?? null;
}

export function updateProviderConfig(input: UpdateProviderInput): ProviderConfig {
  const current = getStoredProviderConfig(input.providerId);
  const now = new Date().toISOString();
  const next: StoredProviderConfig = {
    ...current,
    baseUrl: input.baseUrl !== undefined ? normalizeConfigText(input.baseUrl) || current.baseUrl : current.baseUrl,
    model: input.model !== undefined ? normalizeConfigText(input.model) || current.model : current.model,
    apiKey: input.apiKey !== undefined ? normalizeConfigText(input.apiKey) || current.apiKey : current.apiKey,
    enabled: input.enabled ?? current.enabled,
    updatedAt: now,
  };

  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO provider_configs (
        provider_id, label, base_url, model, api_key, enabled, updated_at
      ) VALUES (
        @providerId, @label, @baseUrl, @model, @apiKey, @enabled, @updatedAt
      )
      ON CONFLICT(provider_id) DO UPDATE SET
        label = excluded.label,
        base_url = excluded.base_url,
        model = excluded.model,
        api_key = excluded.api_key,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `,
  ).run({
    providerId: next.id,
    label: next.label,
    baseUrl: next.baseUrl,
    model: next.model,
    apiKey: next.apiKey,
    enabled: next.enabled ? 1 : 0,
    updatedAt: next.updatedAt,
  });

  return toPublicProviderConfig(next);
}
