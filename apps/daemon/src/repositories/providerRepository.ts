import {
  createDefaultProviderConfig,
  getProviderDefinition,
  listProviderDefinitions,
  type ProviderConfig,
  type ProviderKind,
  type ProviderTransportKind,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";
import { getProviderApiKey, setProviderApiKey } from "../providers/providerSecretStore";

interface ProviderConfigRow {
  providerId: ProviderKind;
  transport: ProviderTransportKind | null;
  baseUrl: string;
  model: string;
  legacyApiKey: string | null;
  enabled: number;
  updatedAt: string;
}

interface UpdateProviderInput {
  providerId: ProviderKind;
  transport?: ProviderTransportKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface StoredProviderConfig {
  id: ProviderKind;
  label: string;
  transport: ProviderTransportKind;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

function normalizeConfigText(value: string) {
  return value.trim().replace(/^[\s"'“”'`]+|[\s"'“”'`。；，、]+$/g, "");
}

function normalizeSecretText(value: string) {
  return value.trim();
}

function inferProviderTransport(baseUrl: string | undefined, fallback: ProviderTransportKind): ProviderTransportKind {
  if (!baseUrl) {
    return fallback;
  }

  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes("/anthropic")) {
    return "anthropic";
  }

  return fallback;
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

function clearLegacyApiKey(providerId: ProviderKind) {
  const db = getDatabase();
  db.prepare(
    `
      UPDATE provider_configs
      SET api_key = NULL
      WHERE provider_id = ?
    `,
  ).run(providerId);
}

function resolveProviderApiKey(providerId: ProviderKind, legacyApiKey: string | null) {
  const keychainApiKey = getProviderApiKey(providerId);
  const normalizedLegacyApiKey = legacyApiKey ? normalizeSecretText(legacyApiKey) : "";

  if (keychainApiKey) {
    if (normalizedLegacyApiKey) {
      clearLegacyApiKey(providerId);
    }
    return keychainApiKey;
  }

  if (!normalizedLegacyApiKey) {
    return null;
  }

  try {
    setProviderApiKey(providerId, normalizedLegacyApiKey);
    clearLegacyApiKey(providerId);
  } catch {
    // Keep the legacy DB value usable if Keychain migration fails.
  }

  return normalizedLegacyApiKey;
}

function toStoredProviderConfig(row: ProviderConfigRow | undefined, providerId: ProviderKind): StoredProviderConfig {
  const definition = getProviderDefinition(providerId);
  const defaultConfig = createDefaultProviderConfig(providerId);
  const baseUrl = row?.baseUrl ?? defaultConfig.baseUrl;

  return {
    id: definition.id,
    label: definition.label,
    transport: row?.transport ?? inferProviderTransport(baseUrl, definition.transport),
    baseUrl,
    model: row?.model ?? defaultConfig.model,
    apiKey: resolveProviderApiKey(providerId, row?.legacyApiKey ?? null),
    enabled: Boolean(row?.enabled ?? defaultConfig.enabled),
    updatedAt: row?.updatedAt ?? defaultConfig.updatedAt,
  };
}

function toPublicProviderConfig(config: StoredProviderConfig): ProviderConfig {
  return {
    id: config.id,
    label: config.label,
    transport: config.transport,
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
          transport,
          base_url AS baseUrl,
          model,
          api_key AS legacyApiKey,
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
  return listProviderDefinitions().map((provider) => getProviderConfig(provider.id));
}

export function getStoredProviderConfig(providerId: ProviderKind): StoredProviderConfig {
  return toStoredProviderConfig(getProviderRow(providerId), providerId);
}

export function getActiveProviderConfig() {
  return listProviderDefinitions()
    .map((provider) => getStoredProviderConfig(provider.id))
    .find((provider) => provider.enabled && provider.apiKey)
    ?? null;
}

export function updateProviderConfig(input: UpdateProviderInput): ProviderConfig {
  const current = getStoredProviderConfig(input.providerId);
  const definition = getProviderDefinition(input.providerId);
  const now = new Date().toISOString();
  const next: StoredProviderConfig = {
    ...current,
    transport: input.transport ?? inferProviderTransport(input.baseUrl ?? current.baseUrl, current.transport),
    baseUrl: input.baseUrl !== undefined ? normalizeConfigText(input.baseUrl) || current.baseUrl : current.baseUrl,
    model: input.model !== undefined ? normalizeConfigText(input.model) || current.model : current.model,
    apiKey: current.apiKey,
    enabled: input.enabled ?? current.enabled,
    updatedAt: now,
  };

  if (input.apiKey !== undefined) {
    const normalizedApiKey = normalizeSecretText(input.apiKey);
    if (normalizedApiKey) {
      setProviderApiKey(input.providerId, normalizedApiKey);
      next.apiKey = normalizedApiKey;
    }
  }

  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO provider_configs (
        provider_id, label, transport, base_url, model, api_key, enabled, updated_at
      ) VALUES (
        @providerId, @label, @transport, @baseUrl, @model, NULL, @enabled, @updatedAt
      )
      ON CONFLICT(provider_id) DO UPDATE SET
        label = excluded.label,
        transport = excluded.transport,
        base_url = excluded.base_url,
        model = excluded.model,
        api_key = NULL,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `,
  ).run({
    providerId: next.id,
    label: definition.label,
    transport: next.transport,
    baseUrl: next.baseUrl,
    model: next.model,
    enabled: next.enabled ? 1 : 0,
    updatedAt: next.updatedAt,
  });

  return toPublicProviderConfig(next);
}
