import type Database from "better-sqlite3";
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryEmbeddingModel,
} from "@aliceloop/runtime-core";
import { z } from "zod";
import { getDatabase } from "../../db/client";

const memoryConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  queryRewrite: z.boolean().optional(),
  embeddingModel: z.enum(["text-embedding-3-small", "text-embedding-3-large"]).optional(),
  embeddingDimension: z.number().int().positive().max(3072).optional(),
}).strict();

const memoryConfigKeys = new Set(Object.keys(DEFAULT_MEMORY_CONFIG) as Array<keyof MemoryConfig>);

function parseStoredConfigValue(rawValue: string) {
  try {
    return JSON.parse(rawValue);
  } catch {
    return undefined;
  }
}

function getDefaultEmbeddingDimension(model: MemoryEmbeddingModel) {
  return model === "text-embedding-3-large" ? 3072 : 1536;
}

function initializeConfig(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO memory_config (key, value)
    VALUES (?, ?)
  `);

  const transaction = db.transaction((config: MemoryConfig) => {
    for (const [key, value] of Object.entries(config)) {
      insert.run(key, JSON.stringify(value));
    }
  });

  transaction(DEFAULT_MEMORY_CONFIG);
}

export function parseMemoryConfigPatch(input: unknown): Partial<MemoryConfig> {
  const patch = memoryConfigPatchSchema.parse(input ?? {});
  if (patch.embeddingModel && patch.embeddingDimension === undefined) {
    patch.embeddingDimension = getDefaultEmbeddingDimension(patch.embeddingModel);
  }
  return patch;
}

export function getMemoryConfig(db: Database.Database = getDatabase()): MemoryConfig {
  const rows = db
    .prepare("SELECT key, value FROM memory_config")
    .all() as Array<{ key: string; value: string }>;

  if (rows.length === 0) {
    initializeConfig(db);
    return { ...DEFAULT_MEMORY_CONFIG };
  }

  const config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
  const configRecord = config as unknown as Record<string, unknown>;
  for (const row of rows) {
    if (!memoryConfigKeys.has(row.key as keyof MemoryConfig)) {
      continue;
    }

    const parsedValue = parseStoredConfigValue(row.value);
    if (parsedValue !== undefined) {
      configRecord[row.key] = parsedValue;
    }
  }

  if (!config.embeddingDimension) {
    config.embeddingDimension = getDefaultEmbeddingDimension(config.embeddingModel);
  }

  return config;
}

export function updateMemoryConfig(
  updates: Partial<MemoryConfig>,
  db: Database.Database = getDatabase(),
) {
  const normalizedUpdates = parseMemoryConfigPatch(updates);
  const entries = Object.entries(normalizedUpdates);
  if (entries.length === 0) {
    return getMemoryConfig(db);
  }

  const insert = db.prepare(`
    INSERT INTO memory_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value
  `);

  const transaction = db.transaction((pairs: Array<[string, unknown]>) => {
    for (const [key, value] of pairs) {
      insert.run(key, JSON.stringify(value));
    }
  });

  transaction(entries);
  return getMemoryConfig(db);
}

export { getDefaultEmbeddingDimension };
