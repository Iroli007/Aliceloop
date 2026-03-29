import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CreateMemoryInput,
  Memory,
  MemoryConfig,
  MemoryFactKind,
  MemoryFactState,
  MemoryNote,
  MemoryStats,
  MemoryWithScore,
  UpdateMemoryInput,
} from "@aliceloop/runtime-core";
import { getDatabase } from "../../db/client";
import {
  deserializeEmbedding,
  generateEmbedding,
  generateEmbeddingsBatch,
  hasEmbeddingProvider,
  serializeEmbedding,
} from "./embeddingService";
import {
  cacheQueryEmbedding,
  getCachedQueryEmbedding,
  getEmbeddingCircuitState,
  recordEmbeddingFailure,
  recordEmbeddingSuccess,
} from "./embeddingRuntime";
import { getMemoryConfig } from "./memoryConfig";
import { rankBySimilarity } from "./vectorSearch";
import { nowMs, roundMs } from "../../runtime/perfTrace";

interface CreateMemoryNoteInput {
  id: string;
  kind: MemoryNote["kind"];
  title: string;
  content: string;
  source: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  content: string;
  source: Memory["source"];
  durability: Memory["durability"];
  factKind: MemoryFactKind | null;
  factKey: string | null;
  factState: MemoryFactState;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  relatedTopics: string;
}

interface MemoryEmbeddingRow {
  memoryId: string;
  embedding: Buffer;
  embeddingDimension: number;
}

export type MemorySearchMode = "semantic" | "lexical";
export const MEMORY_RETRIEVAL_TIMEOUT_REASON = "memory_retrieval_timeout";
export type MemorySearchFallbackReason =
  | "embedding_provider_unavailable"
  | "embedding_circuit_open"
  | "embedding_generation_failed"
  | "embedding_timeout"
  | "embedding_index_missing"
  | null;

export interface MemorySearchResult {
  memories: MemoryWithScore[];
  mode: MemorySearchMode;
  fallbackReason: MemorySearchFallbackReason;
  timings: Record<string, number | string | null>;
}

function getMemoryNoteById(memoryId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          kind,
          title,
          content,
          source,
          updated_at AS updatedAt
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(memoryId) as MemoryNote | undefined;

  return row ?? null;
}

function buildSearchContent(input: Pick<CreateMemoryNoteInput, "title" | "content">) {
  return `${input.title}\n${input.content}`.trim();
}

function syncMemorySearchIndex(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT rowid
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(input.id) as { rowid: number } | undefined;

  if (!row) {
    return;
  }

  db.prepare(
    `
      INSERT OR REPLACE INTO memory_notes_fts (
        rowid,
        memory_id,
        kind,
        content
      ) VALUES (
        @rowid,
        @memoryId,
        @kind,
        @content
      )
    `,
  ).run({
    rowid: row.rowid,
    memoryId: input.id,
    kind: input.kind,
    content: buildSearchContent(input),
  });
}

function normalizeFtsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0)
    .map((term) => `${term}*`)
    .join(" ");
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeFactKey(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, "-") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeFactKind(value: MemoryFactKind | null | undefined): MemoryFactKind | null {
  return value ?? null;
}

function normalizeFactState(value: MemoryFactState | null | undefined): MemoryFactState {
  return value ?? "active";
}

function hasFactIdentity(memory: Pick<Memory, "factKind" | "factKey">) {
  return Boolean(memory.factKind && memory.factKey);
}

const lexicalStopWords = new Set([
  "a",
  "an",
  "and",
  "answer",
  "as",
  "at",
  "be",
  "brief",
  "briefly",
  "for",
  "from",
  "help",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "memory",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "remember",
  "the",
  "this",
  "to",
  "use",
  "with",
]);

function extractLexicalTerms(queryText: string) {
  const normalized = queryText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ");

  const rawTerms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const filteredTerms = Array.from(new Set(rawTerms.filter((term) => !lexicalStopWords.has(term))));
  return filteredTerms.length > 0 ? filteredTerms : Array.from(new Set(rawTerms));
}

function mapMemoryRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    durability: row.durability,
    factKind: row.factKind,
    factKey: row.factKey,
    factState: row.factState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessCount: row.accessCount,
    relatedTopics: parseJsonArray(row.relatedTopics),
  };
}

function getMemoryRowById(
  memoryId: string,
  db: Database.Database = getDatabase(),
) {
  return db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          fact_kind AS factKind,
          fact_key AS factKey,
          fact_state AS factState,
          created_at AS createdAt,
          updated_at AS updatedAt,
          access_count AS accessCount,
          related_topics AS relatedTopics
        FROM memories
        WHERE id = ?
      `,
    )
    .get(memoryId) as MemoryRow | undefined;
}

function getMemoryOrderByColumn(orderBy: "createdAt" | "updatedAt" | "accessCount") {
  switch (orderBy) {
    case "updatedAt":
      return "updated_at";
    case "accessCount":
      return "access_count";
    default:
      return "created_at";
  }
}

function scoreTextMatch(queryText: string, memory: Memory) {
  const significantTerms = extractLexicalTerms(queryText);
  if (significantTerms.length === 0) {
    return 0;
  }

  const haystack = [memory.factKind ?? "", memory.factKey ?? "", memory.content, ...memory.relatedTopics].join(" ").toLowerCase();
  const matchedTerms = significantTerms.filter((term) => haystack.includes(term));
  if (matchedTerms.length === 0) {
    return 0;
  }

  const coverage = matchedTerms.length / significantTerms.length;
  const topicBonus = matchedTerms.some((term) => memory.relatedTopics.some((topic) => topic.toLowerCase().includes(term)))
    ? 0.15
    : 0;
  const factKeyBonus = memory.factKey && queryText.trim().toLowerCase().includes(memory.factKey.toLowerCase())
    ? 0.2
    : 0;
  const exactPhraseBonus = haystack.includes(queryText.trim().toLowerCase()) ? 0.2 : 0;

  return Math.min(1, coverage + topicBonus + factKeyBonus + exactPhraseBonus);
}

function clearMemoryEmbedding(memoryId: string, db: Database.Database = getDatabase()) {
  db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
  db.prepare("DELETE FROM memory_metadata WHERE memory_id = ?").run(memoryId);
}

async function upsertMemoryEmbedding(
  memory: Pick<Memory, "id" | "content">,
  config: MemoryConfig,
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
) {
  if (!hasEmbeddingProvider()) {
    await clearMemoryEmbedding(memory.id, db);
    return;
  }

  const embedding = await generateEmbedding(memory.content, config.embeddingModel, {
    abortSignal,
    dimension: config.embeddingDimension,
  });
  const now = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        embedding = excluded.embedding
    `,
  ).run(memory.id, serializeEmbedding(embedding));

  db.prepare(
    `
      INSERT INTO memory_metadata (
        memory_id,
        embedding_model,
        embedding_dimension,
        created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        created_at = excluded.created_at
    `,
  ).run(memory.id, config.embeddingModel, config.embeddingDimension, now);
}

function searchMemoriesByText(
  queryText: string,
  limit: number,
  threshold: number,
  db: Database.Database = getDatabase(),
) {
  const trimmedQuery = queryText.trim();
  if (!trimmedQuery) {
    return [] as MemoryWithScore[];
  }

  const lexicalTerms = extractLexicalTerms(trimmedQuery);
  if (lexicalTerms.length === 0) {
    return [] as MemoryWithScore[];
  }

  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const term of lexicalTerms) {
    clauses.push("(content LIKE ? OR related_topics LIKE ? OR fact_key LIKE ? OR fact_kind LIKE ?)");
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
  }
  params.push(Math.max(limit * 3, limit));

  const rows = db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          fact_kind AS factKind,
          fact_key AS factKey,
          fact_state AS factState,
          created_at AS createdAt,
          updated_at AS updatedAt,
          access_count AS accessCount,
          related_topics AS relatedTopics
        FROM memories
        WHERE fact_state = 'active'
          AND (${clauses.join(" OR ")})
        ORDER BY access_count DESC, updated_at DESC
        LIMIT ?
      `,
    )
    .all(...params) as MemoryRow[];

  return rows
    .map((row) => {
      const memory = mapMemoryRow(row);
      return {
        ...memory,
        similarityScore: scoreTextMatch(trimmedQuery, memory),
      };
    })
    .filter((memory) => memory.similarityScore >= Math.min(threshold, 0.35))
    .sort((left, right) => right.similarityScore - left.similarityScore)
    .slice(0, limit);
}

export function searchMemoriesLexically(
  queryText: string,
  limit: number,
  threshold: number,
  db: Database.Database = getDatabase(),
) {
  return searchMemoriesByText(queryText, limit, threshold, db);
}

export function countSemanticMemoryCandidates(
  embeddingDimension: number,
  db: Database.Database = getDatabase(),
) {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM memory_metadata
        WHERE embedding_dimension = ?
      `,
    )
    .get(embeddingDimension) as { count: number } | undefined;

  return row?.count ?? 0;
}

export function createMemoryNote(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO memory_notes (
        id, kind, title, content, source, updated_at
      ) VALUES (
        @id, @kind, @title, @content, @source, @updatedAt
      )
    `,
  ).run(input);
  syncMemorySearchIndex(input);

  const created = getMemoryNoteById(input.id);
  if (!created) {
    throw new Error(`Memory note ${input.id} was not created`);
  }

  return created;
}

export function upsertMemoryNote(input: CreateMemoryNoteInput) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO memory_notes (
        id, kind, title, content, source, updated_at
      ) VALUES (
        @id, @kind, @title, @content, @source, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        source = excluded.source,
        updated_at = excluded.updated_at
    `,
  ).run(input);
  syncMemorySearchIndex(input);

  const updated = getMemoryNoteById(input.id);
  if (!updated) {
    throw new Error(`Memory note ${input.id} was not saved`);
  }

  return updated;
}

export function listMemoryNotes(limit = 50, source?: string) {
  const db = getDatabase();
  const normalizedLimit = Math.max(1, Math.min(limit, 200));

  if (source?.trim()) {
    return db
      .prepare(
        `
          SELECT
            id,
            kind,
            title,
            content,
            source,
            updated_at AS updatedAt
          FROM memory_notes
          WHERE source = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(source.trim(), normalizedLimit) as MemoryNote[];
  }

  return db
    .prepare(
      `
        SELECT
          id,
          kind,
          title,
          content,
          source,
          updated_at AS updatedAt
        FROM memory_notes
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(normalizedLimit) as MemoryNote[];
}

export function listMemoryNotesBySourcePrefix(sourcePrefix: string, limit = 50) {
  const db = getDatabase();
  const normalizedPrefix = sourcePrefix.trim();
  if (!normalizedPrefix) {
    return [] as MemoryNote[];
  }

  const normalizedLimit = Math.max(1, Math.min(limit, 200));
  return db
    .prepare(
      `
        SELECT
          id,
          kind,
          title,
          content,
          source,
          updated_at AS updatedAt
        FROM memory_notes
        WHERE source LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(`${normalizedPrefix}%`, normalizedLimit) as MemoryNote[];
}

export function getMemoryNote(memoryId: string) {
  return getMemoryNoteById(memoryId);
}

export function deleteMemoryNote(memoryId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT rowid
        FROM memory_notes
        WHERE id = ?
      `,
    )
    .get(memoryId) as { rowid: number } | undefined;

  if (!row) {
    return false;
  }

  db.prepare(
    `
      DELETE FROM memory_notes_fts
      WHERE rowid = ?
    `,
  ).run(row.rowid);

  const result = db
    .prepare(
      `
        DELETE FROM memory_notes
        WHERE id = ?
      `,
    )
    .run(memoryId);

  return result.changes > 0;
}

export function searchMemoryNotes(query: string, limit = 10, source?: string): MemoryNote[] {
  const db = getDatabase();
  const normalizedSource = source?.trim();

  const hasFts = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_notes_fts'`,
    )
    .get();

  if (hasFts && query.trim()) {
    const normalizedQuery = normalizeFtsQuery(query);
    if (normalizedQuery) {
      try {
        const ftsQuery = normalizedSource
          ? db
            .prepare(
              `
                SELECT
                  m.id,
                  m.kind,
                  m.title,
                  m.content,
                  m.source,
                  m.updated_at AS updatedAt
                FROM memory_notes_fts fts
                JOIN memory_notes m ON m.id = fts.memory_id
                WHERE memory_notes_fts MATCH ?
                  AND m.source = ?
                ORDER BY rank
                LIMIT ?
              `,
            )
            .all(normalizedQuery, normalizedSource, limit)
          : db
            .prepare(
              `
                SELECT
                  m.id,
                  m.kind,
                  m.title,
                  m.content,
                  m.source,
                  m.updated_at AS updatedAt
                FROM memory_notes_fts fts
                JOIN memory_notes m ON m.id = fts.memory_id
                WHERE memory_notes_fts MATCH ?
                ORDER BY rank
                LIMIT ?
              `,
            )
            .all(normalizedQuery, limit);

        const ftsResults = ftsQuery as MemoryNote[];

        if (ftsResults.length > 0) {
          return ftsResults;
        }
      } catch {
        // Fall back to LIKE search when the query cannot be parsed by FTS5.
      }
    }
  }

  if (!query.trim()) {
    return listMemoryNotes(limit, normalizedSource);
  }

  if (normalizedSource) {
    return db
      .prepare(
        `
          SELECT
            id,
            kind,
            title,
            content,
            source,
            updated_at AS updatedAt
          FROM memory_notes
          WHERE source = ?
            AND (content LIKE ? OR title LIKE ?)
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(normalizedSource, `%${query}%`, `%${query}%`, limit) as MemoryNote[];
  }

  return db
    .prepare(
      `
        SELECT
          id,
          kind,
          title,
          content,
          source,
          updated_at AS updatedAt
        FROM memory_notes
        WHERE content LIKE ? OR title LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(`%${query}%`, `%${query}%`, limit) as MemoryNote[];
}

export async function createMemory(
  input: CreateMemoryInput,
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
) {
  const content = input.content.trim();
  if (!content) {
    throw new Error("memory_content_required");
  }

  const now = new Date().toISOString();
  const factKind = normalizeFactKind(input.factKind);
  const factKey = normalizeFactKey(input.factKey);
  const factState = normalizeFactState(input.factState);
  const relatedTopics = input.relatedTopics?.map((topic) => topic.trim()).filter(Boolean) ?? [];
  const memory: Memory = {
    id: randomUUID(),
    content,
    source: input.source,
    durability: input.durability,
    factKind,
    factKey,
    factState,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    relatedTopics,
  };

  if (hasFactIdentity(memory)) {
    const factKind = memory.factKind!;
    const factKey = memory.factKey!;
    const existing = findActiveMemoryByFactIdentity(factKind, factKey, db);
    if (existing) {
      if (memory.factState !== "active") {
        db.prepare(
          `
            UPDATE memories
            SET fact_state = ?,
                updated_at = ?
            WHERE id = ?
          `,
        ).run(memory.factState, now, existing.id);
        clearMemoryEmbedding(existing.id, db);
        return getMemoryById(existing.id, db) ?? existing;
      }

      if (existing.content === memory.content) {
        return existing;
      }

      db.prepare(
        `
          UPDATE memories
          SET fact_state = 'superseded',
              updated_at = ?
          WHERE id = ?
        `,
      ).run(now, existing.id);
      clearMemoryEmbedding(existing.id, db);
    }
  } else {
    const duplicate = findMemoryByExactContent(content, db);
    if (duplicate) {
      return duplicate;
    }
  }

  db.prepare(
    `
      INSERT INTO memories (
        id,
        content,
        source,
        durability,
        fact_kind,
        fact_key,
        fact_state,
        created_at,
        updated_at,
        access_count,
        related_topics
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    memory.id,
    memory.content,
    memory.source,
    memory.durability,
    memory.factKind,
    memory.factKey,
    memory.factState,
    memory.createdAt,
    memory.updatedAt,
    memory.accessCount,
    JSON.stringify(memory.relatedTopics),
  );

  if (memory.factState === "active") {
    try {
      const config = getMemoryConfig(db);
      await upsertMemoryEmbedding(memory, config, db, abortSignal);
    } catch (error) {
      console.warn("[memory] Failed to generate embedding for memory creation", error);
    }
  } else {
    clearMemoryEmbedding(memory.id, db);
  }

  return memory;
}

export async function searchMemories(
  queryText: string,
  limit: number,
  threshold: number,
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
): Promise<MemorySearchResult> {
  const startedAt = nowMs();
  const trimmedQuery = queryText.trim();
  if (!trimmedQuery) {
    return {
      memories: [] as MemoryWithScore[],
      mode: "semantic" as const,
      fallbackReason: null,
      timings: {
        totalMs: 0,
      },
    };
  }

  const normalizedLimit = Math.max(1, Math.min(limit, 50));
  const config = getMemoryConfig(db);

  if (!hasEmbeddingProvider()) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(trimmedQuery, normalizedLimit, threshold, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: "embedding_provider_unavailable" as const,
      timings: {
        lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const cachedEmbedding = getCachedQueryEmbedding(trimmedQuery, config.embeddingModel, config.embeddingDimension);
  const circuitState = getEmbeddingCircuitState();

  let queryEmbedding: Float32Array;
  let embeddingMs = 0;
  let embeddingCacheHit = 0;
  if (cachedEmbedding) {
    queryEmbedding = cachedEmbedding;
    embeddingCacheHit = 1;
  } else if (circuitState.open) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(trimmedQuery, normalizedLimit, threshold, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: "embedding_circuit_open" as const,
      timings: {
        embeddingCacheHit,
        circuitOpen: 1,
        circuitCooldownRemainingMs: roundMs(circuitState.cooldownRemainingMs),
        consecutiveTimeouts: circuitState.consecutiveTimeouts,
        consecutiveFailures: circuitState.consecutiveFailures,
        lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  } else {
    const embeddingStartedAt = nowMs();
    try {
      queryEmbedding = await generateEmbedding(trimmedQuery, config.embeddingModel, {
        abortSignal,
        dimension: config.embeddingDimension,
      });
      embeddingMs = roundMs(nowMs() - embeddingStartedAt);
      cacheQueryEmbedding(trimmedQuery, config.embeddingModel, config.embeddingDimension, queryEmbedding);
      recordEmbeddingSuccess();
    } catch (error) {
      if (abortSignal?.aborted && abortSignal.reason !== MEMORY_RETRIEVAL_TIMEOUT_REASON) {
        throw error;
      }

      const fallbackReason: MemorySearchFallbackReason =
        abortSignal?.reason === MEMORY_RETRIEVAL_TIMEOUT_REASON
          ? "embedding_timeout"
          : "embedding_generation_failed";

      recordEmbeddingFailure(fallbackReason === "embedding_timeout" ? "timeout" : "error");
      console.warn("[memory] Falling back to lexical memory search", error);
      const lexicalStartedAt = nowMs();
      const memories = searchMemoriesByText(trimmedQuery, normalizedLimit, threshold, db);
      return {
        memories,
        mode: "lexical" as const,
        fallbackReason,
        timings: {
          embeddingCacheHit,
          embeddingMs: roundMs(nowMs() - embeddingStartedAt),
          lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
          totalMs: roundMs(nowMs() - startedAt),
        },
      };
    }
  }

  const embeddingRowsStartedAt = nowMs();
  const rows = db
    .prepare(
      `
        SELECT
          embeddings.memory_id AS memoryId,
          embeddings.embedding AS embedding,
          metadata.embedding_dimension AS embeddingDimension
        FROM memory_embeddings embeddings
        JOIN memory_metadata metadata ON metadata.memory_id = embeddings.memory_id
        JOIN memories m ON m.id = embeddings.memory_id
        WHERE metadata.embedding_dimension = ?
          AND m.fact_state = 'active'
      `,
    )
    .all(config.embeddingDimension) as MemoryEmbeddingRow[];
  const embeddingRowsMs = roundMs(nowMs() - embeddingRowsStartedAt);

  if (rows.length === 0) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(trimmedQuery, normalizedLimit, threshold, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: "embedding_index_missing" as const,
      timings: {
        embeddingCacheHit,
        embeddingMs,
        embeddingRowsMs,
        lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const vectorRankStartedAt = nowMs();
  const scoredMemories = rankBySimilarity(
    queryEmbedding,
    rows.map((row) => ({
      memoryId: row.memoryId,
      embedding: deserializeEmbedding(row.embedding),
    })),
    normalizedLimit,
    threshold,
  );
  const vectorRankMs = roundMs(nowMs() - vectorRankStartedAt);

  if (scoredMemories.length === 0) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(trimmedQuery, normalizedLimit, threshold, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: null,
      timings: {
        embeddingCacheHit,
        embeddingMs,
        embeddingRowsMs,
        vectorRankMs,
        lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const hydrateStartedAt = nowMs();
  const memories = scoredMemories
    .map((scoredMemory) => {
      const row = getMemoryRowById(scoredMemory.memoryId, db);
      if (!row) {
        return null;
      }

      return {
        ...mapMemoryRow(row),
        similarityScore: scoredMemory.score,
      };
    })
    .filter((memory): memory is MemoryWithScore => memory !== null);
  const hydrateMs = roundMs(nowMs() - hydrateStartedAt);

  return {
    memories,
    mode: "semantic" as const,
    fallbackReason: null,
    timings: {
      embeddingCacheHit,
      embeddingMs,
      embeddingRowsMs,
      vectorRankMs,
      hydrateMs,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}

export async function searchMemoriesBySimilarity(
  queryText: string,
  limit: number,
  threshold: number,
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
) {
  const result = await searchMemories(queryText, limit, threshold, db, abortSignal);
  return result.memories;
}

export function incrementAccessCount(memoryId: string, db: Database.Database = getDatabase()) {
  const result = db
    .prepare(
      `
        UPDATE memories
        SET access_count = access_count + 1
        WHERE id = ?
      `,
    )
    .run(memoryId);

  return result.changes > 0;
}

export function getMemoryStats(db: Database.Database = getDatabase()): MemoryStats {
  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS totalCount,
          COALESCE(SUM(CASE WHEN source = 'auto' THEN 1 ELSE 0 END), 0) AS autoCount,
          COALESCE(SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END), 0) AS manualCount,
          COALESCE(SUM(CASE WHEN durability = 'permanent' THEN 1 ELSE 0 END), 0) AS permanentCount,
          COALESCE(SUM(CASE WHEN durability = 'temporary' THEN 1 ELSE 0 END), 0) AS temporaryCount,
          COALESCE(SUM(access_count), 0) AS totalAccessCount,
          COALESCE(AVG(access_count), 0) AS avgAccessCount,
          MIN(created_at) AS oldestMemory,
          MAX(created_at) AS newestMemory
        FROM memories
      `,
    )
    .get() as MemoryStats | undefined;

  return row ?? {
    totalCount: 0,
    autoCount: 0,
    manualCount: 0,
    permanentCount: 0,
    temporaryCount: 0,
    totalAccessCount: 0,
    avgAccessCount: 0,
    oldestMemory: null,
    newestMemory: null,
  };
}

export function getMemoryById(memoryId: string, db: Database.Database = getDatabase()) {
  const row = getMemoryRowById(memoryId, db);
  return row ? mapMemoryRow(row) : null;
}

export function findMemoryByExactContent(content: string, db: Database.Database = getDatabase()) {
  const row = db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          fact_kind AS factKind,
          fact_key AS factKey,
          fact_state AS factState,
          created_at AS createdAt,
          updated_at AS updatedAt,
          access_count AS accessCount,
          related_topics AS relatedTopics
        FROM memories
        WHERE content = ?
          AND fact_state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(content.trim()) as MemoryRow | undefined;

  return row ? mapMemoryRow(row) : null;
}

function findActiveMemoryByFactIdentity(
  factKind: MemoryFactKind,
  factKey: string,
  db: Database.Database = getDatabase(),
) {
  const row = db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          fact_kind AS factKind,
          fact_key AS factKey,
          fact_state AS factState,
          created_at AS createdAt,
          updated_at AS updatedAt,
          access_count AS accessCount,
          related_topics AS relatedTopics
        FROM memories
        WHERE fact_kind = ?
          AND fact_key = ?
          AND fact_state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(factKind, factKey) as MemoryRow | undefined;

  return row ? mapMemoryRow(row) : null;
}

export async function updateMemory(
  memoryId: string,
  updates: UpdateMemoryInput,
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
) {
  const current = getMemoryById(memoryId, db);
  if (!current) {
    return null;
  }

  const nextContent = updates.content?.trim() ?? current.content;
  if (!nextContent) {
    throw new Error("memory_content_required");
  }

  const nextFactKind = updates.factKind !== undefined ? normalizeFactKind(updates.factKind) : current.factKind;
  const nextFactKey = updates.factKey !== undefined ? normalizeFactKey(updates.factKey) : current.factKey;
  const nextFactState = normalizeFactState(updates.factState ?? current.factState);
  const nextRelatedTopics = updates.relatedTopics
    ? updates.relatedTopics.map((topic) => topic.trim()).filter(Boolean)
    : current.relatedTopics;
  const nextUpdatedAt = new Date().toISOString();

  if (nextFactState === "active" && nextFactKind && nextFactKey) {
    const conflicting = db
      .prepare(
        `
          SELECT
            id,
            content,
            source,
            durability,
            fact_kind AS factKind,
            fact_key AS factKey,
            fact_state AS factState,
            created_at AS createdAt,
            updated_at AS updatedAt,
            access_count AS accessCount,
            related_topics AS relatedTopics
          FROM memories
          WHERE fact_kind = ?
            AND fact_key = ?
            AND fact_state = 'active'
            AND id <> ?
          ORDER BY updated_at DESC
          LIMIT 1
        `,
      )
      .get(nextFactKind, nextFactKey, memoryId) as MemoryRow | undefined;

    if (conflicting) {
      db.prepare(
        `
          UPDATE memories
          SET fact_state = 'superseded',
              updated_at = ?
          WHERE id = ?
        `,
      ).run(nextUpdatedAt, conflicting.id);
      clearMemoryEmbedding(conflicting.id, db);
    }
  }

  db.prepare(
    `
      UPDATE memories
      SET
        content = ?,
        durability = ?,
        fact_kind = ?,
        fact_key = ?,
        fact_state = ?,
        related_topics = ?,
        updated_at = ?
      WHERE id = ?
    `,
  ).run(
    nextContent,
    updates.durability ?? current.durability,
    nextFactKind,
    nextFactKey,
    nextFactState,
    JSON.stringify(nextRelatedTopics),
    nextUpdatedAt,
    memoryId,
  );

  if (updates.content !== undefined || updates.factKind !== undefined || updates.factKey !== undefined || updates.factState !== undefined) {
    if (nextFactState !== "active") {
      clearMemoryEmbedding(memoryId, db);
      return getMemoryById(memoryId, db);
    }

    try {
      const config = getMemoryConfig(db);
      await upsertMemoryEmbedding({ id: memoryId, content: nextContent }, config, db, abortSignal);
    } catch (error) {
      await clearMemoryEmbedding(memoryId, db);
      console.warn("[memory] Failed to refresh embedding after memory update", error);
    }
  }

  return getMemoryById(memoryId, db);
}

export function deleteMemory(memoryId: string, db: Database.Database = getDatabase()) {
  const current = getMemoryById(memoryId, db);
  if (!current) {
    return false;
  }

  if (current.factKind && current.factKey) {
    const updatedAt = new Date().toISOString();
    db.prepare(
      `
        UPDATE memories
        SET fact_state = 'retracted',
            updated_at = ?
        WHERE id = ?
      `,
    ).run(updatedAt, memoryId);
    clearMemoryEmbedding(memoryId, db);
    return true;
  }

  const result = db
    .prepare(
      `
        DELETE FROM memories
        WHERE id = ?
      `,
    )
    .run(memoryId);

  return result.changes > 0;
}

export function listMemories(
  options: {
    limit?: number;
    offset?: number;
    source?: Memory["source"];
    durability?: Memory["durability"];
    orderBy?: "createdAt" | "updatedAt" | "accessCount";
    order?: "ASC" | "DESC";
  } = {},
  db: Database.Database = getDatabase(),
) {
  const {
    limit = 50,
    offset = 0,
    source,
    durability,
    orderBy = "createdAt",
    order = "DESC",
  } = options;

  const normalizedLimit = Math.max(1, Math.min(limit, 200));
  const normalizedOffset = Math.max(0, offset);
  const normalizedOrder = order === "ASC" ? "ASC" : "DESC";
  const params: Array<string | number> = [];
  let query = `
    SELECT
      id,
      content,
      source,
      durability,
      fact_kind AS factKind,
      fact_key AS factKey,
      fact_state AS factState,
      created_at AS createdAt,
      updated_at AS updatedAt,
      access_count AS accessCount,
      related_topics AS relatedTopics
    FROM memories
    WHERE fact_state = 'active'
  `;

  if (source) {
    query += " AND source = ?";
    params.push(source);
  }

  if (durability) {
    query += " AND durability = ?";
    params.push(durability);
  }

  query += ` ORDER BY ${getMemoryOrderByColumn(orderBy)} ${normalizedOrder} LIMIT ? OFFSET ?`;
  params.push(normalizedLimit, normalizedOffset);

  const rows = db.prepare(query).all(...params) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function clearAllMemories(db: Database.Database = getDatabase()) {
  db.prepare("DELETE FROM memories").run();
}

export async function rebuildAllEmbeddings(
  db: Database.Database = getDatabase(),
  abortSignal?: AbortSignal,
) {
  if (!hasEmbeddingProvider()) {
    throw new Error("embedding_provider_not_configured");
  }

  const config = getMemoryConfig(db);
  const memories = db
    .prepare(
      `
        SELECT
          id,
          content
        FROM memories
        WHERE fact_state = 'active'
        ORDER BY created_at ASC
      `,
    )
    .all() as Array<{ id: string; content: string }>;

  if (memories.length === 0) {
    return { rebuiltCount: 0 };
  }

  const insertEmbedding = db.prepare(
    `
      INSERT INTO memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        embedding = excluded.embedding
    `,
  );
  const insertMetadata = db.prepare(
    `
      INSERT INTO memory_metadata (
        memory_id,
        embedding_model,
        embedding_dimension,
        created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        created_at = excluded.created_at
    `,
  );
  const persistBatch = db.transaction((batch: Array<{ id: string; embedding: Float32Array }>, createdAt: string) => {
    for (const memory of batch) {
      insertEmbedding.run(memory.id, serializeEmbedding(memory.embedding));
      insertMetadata.run(memory.id, config.embeddingModel, config.embeddingDimension, createdAt);
    }
  });

  const batchSize = 64;
  let rebuiltCount = 0;

  for (let index = 0; index < memories.length; index += batchSize) {
    const batch = memories.slice(index, index + batchSize);
    const embeddings = await generateEmbeddingsBatch(
      batch.map((memory) => memory.content),
      config.embeddingModel,
      {
        abortSignal,
        dimension: config.embeddingDimension,
      },
    );

    persistBatch(
      batch.map((memory, batchIndex) => ({
        id: memory.id,
        embedding: embeddings[batchIndex],
      })),
      new Date().toISOString(),
    );
    rebuiltCount += batch.length;
  }

  return { rebuiltCount };
}
