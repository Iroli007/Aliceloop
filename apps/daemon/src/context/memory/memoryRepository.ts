import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CreateMemoryInput,
  Memory,
  MemoryConfig,
  MemoryFactKind,
  MemoryFactState,
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
import { rewriteQuery } from "./queryRewriter";
import { rankBySimilarity } from "./vectorSearch";
import { nowMs, roundMs } from "../../runtime/perfTrace";

interface MemoryRow {
  id: string;
  content: string;
  source: Memory["source"];
  durability: Memory["durability"];
  projectId: string | null;
  sessionId: string | null;
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
export const DEFAULT_SEMANTIC_MEMORY_RETRIEVAL_LIMIT = 8;
export const DEFAULT_SEMANTIC_MEMORY_SIMILARITY_THRESHOLD = 0.7;
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

interface MemoryScopeFilter {
  projectId?: string | null;
  sessionId?: string | null;
  includeGlobal?: boolean;
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

function normalizeScopeId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function normalizeMemoryScopeFilter(scope?: MemoryScopeFilter) {
  return {
    projectId: normalizeScopeId(scope?.projectId),
    sessionId: normalizeScopeId(scope?.sessionId),
    includeGlobal: scope?.includeGlobal !== false,
  };
}

function qualifyColumn(alias: string | undefined, columnName: string) {
  return alias ? `${alias}.${columnName}` : columnName;
}

function buildExactScopeClause(
  scope: MemoryScopeFilter | undefined,
  params: Array<string | number>,
  alias?: string,
) {
  const normalized = normalizeMemoryScopeFilter(scope);
  const projectColumn = qualifyColumn(alias, "project_id");
  const sessionColumn = qualifyColumn(alias, "session_id");
  const clauses: string[] = [];

  if (normalized.projectId) {
    clauses.push(`${projectColumn} = ?`);
    params.push(normalized.projectId);
  } else {
    clauses.push(`${projectColumn} IS NULL`);
  }

  if (normalized.sessionId) {
    clauses.push(`${sessionColumn} = ?`);
    params.push(normalized.sessionId);
  } else {
    clauses.push(`${sessionColumn} IS NULL`);
  }

  return clauses.join(" AND ");
}

function buildRetrievalScopeClause(
  scope: MemoryScopeFilter | undefined,
  params: Array<string | number>,
  alias?: string,
) {
  const normalized = normalizeMemoryScopeFilter(scope);
  const projectColumn = qualifyColumn(alias, "project_id");
  const sessionColumn = qualifyColumn(alias, "session_id");
  const clauses: string[] = [];

  if (normalized.sessionId) {
    clauses.push(`${sessionColumn} = ?`);
    params.push(normalized.sessionId);
  }

  if (normalized.projectId) {
    clauses.push(`${sessionColumn} IS NULL AND ${projectColumn} = ?`);
    params.push(normalized.projectId);
  }

  if (normalized.includeGlobal && (normalized.sessionId || normalized.projectId)) {
    clauses.push(`${sessionColumn} IS NULL AND ${projectColumn} IS NULL`);
  }

  if (clauses.length === 0) {
    return "";
  }

  return clauses.map((clause) => `(${clause})`).join(" OR ");
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

const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const maxLexicalTerms = 16;
const lexicalCoarseCandidateLimitFloor = 24;
const lexicalStrongCandidateCountFloor = 3;
const lexicalWeakScoreThreshold = 0.45;
const lexicalModerateScoreThreshold = 0.6;

function hasCjkCharacters(value: string) {
  return cjkPattern.test(value);
}

function buildCjkBigrams(term: string) {
  if (term.length <= 2) {
    return [term];
  }

  const bigrams: string[] = [];
  for (let index = 0; index < term.length - 1; index += 1) {
    bigrams.push(term.slice(index, index + 2));
  }
  return bigrams;
}

function buildCjkTrigrams(term: string) {
  if (term.length <= 3) {
    return [term];
  }

  const trigrams: string[] = [];
  for (let index = 0; index < term.length - 2; index += 1) {
    trigrams.push(term.slice(index, index + 3));
  }
  return trigrams;
}

function normalizeLexicalSourceTerms(queryText: string) {
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

function extractLexicalTerms(queryText: string) {
  const sourceTerms = normalizeLexicalSourceTerms(queryText);
  const expandedTerms = sourceTerms.flatMap((term) => {
    if (!hasCjkCharacters(term)) {
      return [term];
    }

    return term.length <= 6
      ? [term, ...buildCjkBigrams(term)]
      : buildCjkBigrams(term);
  });

  return Array.from(new Set(expandedTerms)).slice(0, maxLexicalTerms);
}

function extractFtsTerms(queryText: string) {
  const sourceTerms = normalizeLexicalSourceTerms(queryText);
  const expandedTerms = sourceTerms.flatMap((term) => {
    if (hasCjkCharacters(term)) {
      if (term.length < 3) {
        return [];
      }

      return term.length <= 6
        ? [term, ...buildCjkTrigrams(term)]
        : buildCjkTrigrams(term);
    }

    return term.length >= 3 ? [term] : [];
  });

  return Array.from(new Set(expandedTerms)).slice(0, maxLexicalTerms);
}

function buildMemorySearchText(memory: Pick<Memory, "content" | "factKind" | "factKey" | "relatedTopics">) {
  return [
    memory.content,
    memory.factKind ?? "",
    memory.factKey ?? "",
    memory.relatedTopics.join(" "),
  ]
    .join("\n")
    .trim();
}

function syncMemorySearchIndex(
  memory: Pick<Memory, "id" | "content" | "factKind" | "factKey" | "factState" | "relatedTopics">,
  db: Database.Database = getDatabase(),
) {
  db.prepare("DELETE FROM memory_search_fts WHERE memory_id = ?").run(memory.id);
  if (memory.factState !== "active") {
    return;
  }

  db.prepare(
    `
      INSERT INTO memory_search_fts (
        memory_id,
        search_text
      ) VALUES (?, ?)
    `,
  ).run(memory.id, buildMemorySearchText(memory));
}

function removeMemorySearchIndex(memoryId: string, db: Database.Database = getDatabase()) {
  db.prepare("DELETE FROM memory_search_fts WHERE memory_id = ?").run(memoryId);
}

function mapMemoryRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    durability: row.durability,
    projectId: row.projectId,
    sessionId: row.sessionId,
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
          project_id AS projectId,
          session_id AS sessionId,
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

function getLexicalCandidateLimit(limit: number) {
  return Math.max(limit * 4, lexicalCoarseCandidateLimitFloor);
}

function assessLexicalCandidates(candidates: MemoryWithScore[], limit: number) {
  const candidateCount = candidates.length;
  const topScore = candidates[0]?.similarityScore ?? 0;
  const strongEnoughCount = Math.min(limit, lexicalStrongCandidateCountFloor);
  const weak = candidateCount === 0
    || topScore < lexicalWeakScoreThreshold
    || (candidateCount < strongEnoughCount && topScore < lexicalModerateScoreThreshold);

  return {
    candidateCount,
    topScore,
    weak,
  };
}

function loadMemoryEmbeddingRows(
  embeddingDimension: number,
  scope: MemoryScopeFilter | undefined,
  db: Database.Database = getDatabase(),
  memoryIds?: string[],
) {
  if (memoryIds && memoryIds.length === 0) {
    return [] as MemoryEmbeddingRow[];
  }

  const params: Array<string | number> = [embeddingDimension];
  const clauses = ["metadata.embedding_dimension = ?", "m.fact_state = 'active'"];
  const scopeClause = buildRetrievalScopeClause(scope, params, "m");
  if (scopeClause) {
    clauses.push(`(${scopeClause})`);
  }

  if (memoryIds) {
    clauses.push(`embeddings.memory_id IN (${memoryIds.map(() => "?").join(", ")})`);
    params.push(...memoryIds);
  }

  return db
    .prepare(
      `
        SELECT
          embeddings.memory_id AS memoryId,
          embeddings.embedding AS embedding,
          metadata.embedding_dimension AS embeddingDimension
        FROM memory_embeddings embeddings
        JOIN memory_metadata metadata ON metadata.memory_id = embeddings.memory_id
        JOIN memories m ON m.id = embeddings.memory_id
        WHERE ${clauses.join("\n          AND ")}
      `,
    )
    .all(...params) as MemoryEmbeddingRow[];
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
  scope: MemoryScopeFilter | undefined,
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

  const normalizedLimit = Math.max(limit * 3, limit);
  const ftsTerms = extractFtsTerms(trimmedQuery);
  const params: Array<string | number> = [];
  const scopeClause = buildRetrievalScopeClause(scope, params, "m");
  let rows: MemoryRow[];

  if (ftsTerms.length > 0) {
    const ftsQuery = ftsTerms
      .map((term) => `"${term.replace(/"/g, "\"\"")}"`)
      .join(" OR ");
    rows = db
      .prepare(
        `
          SELECT
            m.id AS id,
            m.content AS content,
            m.source AS source,
            m.durability AS durability,
            m.project_id AS projectId,
            m.session_id AS sessionId,
            m.fact_kind AS factKind,
            m.fact_key AS factKey,
            m.fact_state AS factState,
            m.created_at AS createdAt,
            m.updated_at AS updatedAt,
            m.access_count AS accessCount,
            m.related_topics AS relatedTopics
          FROM memory_search_fts
          JOIN memories m ON m.id = memory_search_fts.memory_id
          WHERE memory_search_fts MATCH ?
            AND m.fact_state = 'active'
            ${scopeClause ? `AND (${scopeClause})` : ""}
          ORDER BY bm25(memory_search_fts), m.access_count DESC, m.updated_at DESC
          LIMIT ?
        `,
      )
      .all(ftsQuery, ...params, normalizedLimit) as MemoryRow[];
  } else {
    rows = db
      .prepare(
        `
          SELECT
            id,
            content,
            source,
            durability,
            project_id AS projectId,
            session_id AS sessionId,
            fact_kind AS factKind,
            fact_key AS factKey,
            fact_state AS factState,
            created_at AS createdAt,
            updated_at AS updatedAt,
            access_count AS accessCount,
            related_topics AS relatedTopics
          FROM memories
          WHERE fact_state = 'active'
            ${scopeClause ? `AND (${scopeClause})` : ""}
        `,
      )
      .all(...params) as MemoryRow[];
  }

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
  scope: MemoryScopeFilter | undefined,
  db: Database.Database = getDatabase(),
) {
  return searchMemoriesByText(queryText, limit, threshold, scope, db);
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
  const projectId = normalizeScopeId(input.projectId);
  const sessionId = normalizeScopeId(input.sessionId);
  const relatedTopics = input.relatedTopics?.map((topic) => topic.trim()).filter(Boolean) ?? [];
  const memory: Memory = {
    id: randomUUID(),
    content,
    source: input.source,
    durability: input.durability,
    projectId,
    sessionId,
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
    const existing = findActiveMemoryByFactIdentity(factKind, factKey, {
      projectId: memory.projectId,
      sessionId: memory.sessionId,
    }, db);
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
        removeMemorySearchIndex(existing.id, db);
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
      removeMemorySearchIndex(existing.id, db);
    }
  } else {
    const duplicate = findMemoryByExactContent(content, {
      projectId: memory.projectId,
      sessionId: memory.sessionId,
    }, db);
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
        project_id,
        session_id,
        fact_kind,
        fact_key,
        fact_state,
        created_at,
        updated_at,
        access_count,
        related_topics
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    memory.id,
    memory.content,
    memory.source,
    memory.durability,
    memory.projectId,
    memory.sessionId,
    memory.factKind,
    memory.factKey,
    memory.factState,
    memory.createdAt,
    memory.updatedAt,
    memory.accessCount,
    JSON.stringify(memory.relatedTopics),
  );

  if (memory.factState === "active") {
    syncMemorySearchIndex(memory, db);
    try {
      const config = getMemoryConfig(db);
      await upsertMemoryEmbedding(memory, config, db, abortSignal);
    } catch (error) {
      console.warn("[memory] Failed to generate embedding for memory creation", error);
    }
  } else {
    removeMemorySearchIndex(memory.id, db);
    clearMemoryEmbedding(memory.id, db);
  }

  return memory;
}

export async function searchMemories(
  queryText: string,
  limit: number,
  threshold: number,
  options: {
    scope?: MemoryScopeFilter;
    db?: Database.Database;
    abortSignal?: AbortSignal;
  } = {},
): Promise<MemorySearchResult> {
  const db = options.db ?? getDatabase();
  const abortSignal = options.abortSignal;
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
  let retrievalQuery = trimmedQuery;
  const lexicalCandidateLimit = getLexicalCandidateLimit(normalizedLimit);
  const lexicalCoarseStartedAt = nowMs();
  let lexicalCandidates = searchMemoriesByText(retrievalQuery, lexicalCandidateLimit, 0, options.scope, db);
  let lexicalCoarseMs = roundMs(nowMs() - lexicalCoarseStartedAt);
  let lexicalSignal = assessLexicalCandidates(lexicalCandidates, normalizedLimit);
  let queryRewriteMs = 0;
  let queryRewritten = 0;
  let queryRewriteTriggered = 0;

  if (config.queryRewrite && lexicalSignal.weak) {
    const queryRewriteStartedAt = nowMs();
    queryRewriteTriggered = 1;
    retrievalQuery = (await rewriteQuery(trimmedQuery, abortSignal)).trim() || trimmedQuery;
    queryRewriteMs = roundMs(nowMs() - queryRewriteStartedAt);
    queryRewritten = retrievalQuery !== trimmedQuery ? 1 : 0;
    if (queryRewritten) {
      const rewrittenLexicalStartedAt = nowMs();
      lexicalCandidates = searchMemoriesByText(retrievalQuery, lexicalCandidateLimit, 0, options.scope, db);
      lexicalCoarseMs = roundMs(lexicalCoarseMs + (nowMs() - rewrittenLexicalStartedAt));
      lexicalSignal = assessLexicalCandidates(lexicalCandidates, normalizedLimit);
    }
  }

  if (!hasEmbeddingProvider()) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(retrievalQuery, normalizedLimit, threshold, options.scope, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: "embedding_provider_unavailable" as const,
      timings: {
        lexicalCoarseMs,
        lexicalCandidateCount: lexicalSignal.candidateCount,
        lexicalTopScore: lexicalSignal.topScore,
        lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
        queryRewriteMs,
        queryRewritten,
        queryRewriteTriggered,
        lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const cachedEmbedding = getCachedQueryEmbedding(retrievalQuery, config.embeddingModel, config.embeddingDimension);
  const circuitState = getEmbeddingCircuitState();

  let queryEmbedding: Float32Array;
  let embeddingMs = 0;
  let embeddingCacheHit = 0;
  if (cachedEmbedding) {
    queryEmbedding = cachedEmbedding;
    embeddingCacheHit = 1;
  } else if (circuitState.open) {
    const lexicalStartedAt = nowMs();
    const memories = searchMemoriesByText(retrievalQuery, normalizedLimit, threshold, options.scope, db);
    return {
      memories,
      mode: "lexical" as const,
      fallbackReason: "embedding_circuit_open" as const,
      timings: {
        lexicalCoarseMs,
        lexicalCandidateCount: lexicalSignal.candidateCount,
        lexicalTopScore: lexicalSignal.topScore,
        lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
        queryRewriteMs,
        queryRewritten,
        queryRewriteTriggered,
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
      queryEmbedding = await generateEmbedding(retrievalQuery, config.embeddingModel, {
        abortSignal,
        dimension: config.embeddingDimension,
      });
      embeddingMs = roundMs(nowMs() - embeddingStartedAt);
      cacheQueryEmbedding(retrievalQuery, config.embeddingModel, config.embeddingDimension, queryEmbedding);
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
      const memories = searchMemoriesByText(retrievalQuery, normalizedLimit, threshold, options.scope, db);
      return {
        memories,
        mode: "lexical" as const,
        fallbackReason,
        timings: {
          lexicalCoarseMs,
          lexicalCandidateCount: lexicalSignal.candidateCount,
          lexicalTopScore: lexicalSignal.topScore,
          lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
          queryRewriteMs,
          queryRewritten,
          queryRewriteTriggered,
          embeddingCacheHit,
          embeddingMs: roundMs(nowMs() - embeddingStartedAt),
          lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
          totalMs: roundMs(nowMs() - startedAt),
        },
      };
    }
  }

  let semanticStrategy = "candidate-rerank";
  let semanticCandidateEmbeddingRowsMs = 0;
  let semanticCandidateCount = lexicalCandidates.length;
  let semanticCandidateVectorRankMs = 0;
  let semanticFullScanTriggered = 0;
  let embeddingRowsMs = 0;
  let vectorRankMs = 0;
  let scoredMemories = [] as Array<{ memoryId: string; score: number }>;

  if (lexicalCandidates.length > 0) {
    const candidateRowLookupStartedAt = nowMs();
    const candidateRows = loadMemoryEmbeddingRows(
      config.embeddingDimension,
      options.scope,
      db,
      lexicalCandidates.map((memory) => memory.id),
    );
    semanticCandidateEmbeddingRowsMs = roundMs(nowMs() - candidateRowLookupStartedAt);

    if (candidateRows.length > 0) {
      const candidateRankStartedAt = nowMs();
      scoredMemories = rankBySimilarity(
        queryEmbedding,
        candidateRows.map((row) => ({
          memoryId: row.memoryId,
          embedding: deserializeEmbedding(row.embedding),
        })),
        normalizedLimit,
        threshold,
      );
      semanticCandidateVectorRankMs = roundMs(nowMs() - candidateRankStartedAt);
    }
  }

  if (lexicalSignal.weak || scoredMemories.length === 0) {
    semanticStrategy = "full-scan";
    semanticFullScanTriggered = 1;
    const embeddingRowsStartedAt = nowMs();
    const rows = loadMemoryEmbeddingRows(config.embeddingDimension, options.scope, db);
    embeddingRowsMs = roundMs(nowMs() - embeddingRowsStartedAt);

    if (rows.length === 0) {
      const lexicalStartedAt = nowMs();
      const memories = searchMemoriesByText(retrievalQuery, normalizedLimit, threshold, options.scope, db);
      return {
        memories,
        mode: "lexical" as const,
        fallbackReason: "embedding_index_missing" as const,
        timings: {
          lexicalCoarseMs,
          lexicalCandidateCount: lexicalSignal.candidateCount,
          lexicalTopScore: lexicalSignal.topScore,
          lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
          queryRewriteMs,
          queryRewritten,
          queryRewriteTriggered,
          embeddingCacheHit,
          embeddingMs,
          semanticStrategy,
          semanticCandidateCount,
          semanticCandidateEmbeddingRowsMs,
          semanticCandidateVectorRankMs,
          semanticFullScanTriggered,
          embeddingRowsMs,
          lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
          totalMs: roundMs(nowMs() - startedAt),
        },
      };
    }

    const fullScanRankStartedAt = nowMs();
    scoredMemories = rankBySimilarity(
      queryEmbedding,
      rows.map((row) => ({
        memoryId: row.memoryId,
        embedding: deserializeEmbedding(row.embedding),
      })),
      normalizedLimit,
      threshold,
    );
    vectorRankMs = roundMs(nowMs() - fullScanRankStartedAt);

    if (scoredMemories.length === 0) {
      const lexicalStartedAt = nowMs();
      const memories = searchMemoriesByText(retrievalQuery, normalizedLimit, threshold, options.scope, db);
      return {
        memories,
        mode: "lexical" as const,
        fallbackReason: null,
        timings: {
          lexicalCoarseMs,
          lexicalCandidateCount: lexicalSignal.candidateCount,
          lexicalTopScore: lexicalSignal.topScore,
          lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
          queryRewriteMs,
          queryRewritten,
          queryRewriteTriggered,
          embeddingCacheHit,
          embeddingMs,
          semanticStrategy,
          semanticCandidateCount,
          semanticCandidateEmbeddingRowsMs,
          semanticCandidateVectorRankMs,
          semanticFullScanTriggered,
          embeddingRowsMs,
          vectorRankMs,
          lexicalLookupMs: roundMs(nowMs() - lexicalStartedAt),
          totalMs: roundMs(nowMs() - startedAt),
        },
      };
    }
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
      lexicalCoarseMs,
      lexicalCandidateCount: lexicalSignal.candidateCount,
      lexicalTopScore: lexicalSignal.topScore,
      lexicalWeakSignal: lexicalSignal.weak ? 1 : 0,
      queryRewriteMs,
      queryRewritten,
      queryRewriteTriggered,
      embeddingCacheHit,
      embeddingMs,
      semanticStrategy,
      semanticCandidateCount,
      semanticCandidateEmbeddingRowsMs,
      semanticCandidateVectorRankMs,
      semanticFullScanTriggered,
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
  options: {
    scope?: MemoryScopeFilter;
    db?: Database.Database;
    abortSignal?: AbortSignal;
  } = {},
) {
  const result = await searchMemories(queryText, limit, threshold, options);
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

export function findMemoryByExactContent(
  content: string,
  scope?: MemoryScopeFilter,
  db: Database.Database = getDatabase(),
) {
  const params: Array<string | number> = [content.trim()];
  const scopeClause = buildExactScopeClause(scope, params);
  const row = db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          project_id AS projectId,
          session_id AS sessionId,
          fact_kind AS factKind,
          fact_key AS factKey,
          fact_state AS factState,
          created_at AS createdAt,
          updated_at AS updatedAt,
          access_count AS accessCount,
          related_topics AS relatedTopics
        FROM memories
        WHERE content = ?
          AND ${scopeClause}
          AND fact_state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...params) as MemoryRow | undefined;

  return row ? mapMemoryRow(row) : null;
}

function findActiveMemoryByFactIdentity(
  factKind: MemoryFactKind,
  factKey: string,
  scope?: MemoryScopeFilter,
  db: Database.Database = getDatabase(),
) {
  const params: Array<string | number> = [factKind, factKey];
  const scopeClause = buildExactScopeClause(scope, params);
  const row = db
    .prepare(
      `
        SELECT
          id,
          content,
          source,
          durability,
          project_id AS projectId,
          session_id AS sessionId,
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
          AND ${scopeClause}
          AND fact_state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...params) as MemoryRow | undefined;

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
    const conflictParams: Array<string | number> = [nextFactKind, nextFactKey];
    const conflictScopeClause = buildExactScopeClause({
      projectId: current.projectId,
      sessionId: current.sessionId,
    }, conflictParams);
    conflictParams.push(memoryId);
    const conflicting = db
      .prepare(
        `
          SELECT
            id,
            content,
            source,
            durability,
            project_id AS projectId,
            session_id AS sessionId,
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
            AND ${conflictScopeClause}
            AND fact_state = 'active'
            AND id <> ?
          ORDER BY updated_at DESC
          LIMIT 1
        `,
      )
      .get(...conflictParams) as MemoryRow | undefined;

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
      removeMemorySearchIndex(conflicting.id, db);
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

  if (
    updates.content !== undefined
    || updates.factKind !== undefined
    || updates.factKey !== undefined
    || updates.factState !== undefined
    || updates.relatedTopics !== undefined
  ) {
    if (nextFactState !== "active") {
      removeMemorySearchIndex(memoryId, db);
      clearMemoryEmbedding(memoryId, db);
      return getMemoryById(memoryId, db);
    }

    syncMemorySearchIndex({
      id: memoryId,
      content: nextContent,
      factKind: nextFactKind,
      factKey: nextFactKey,
      factState: nextFactState,
      relatedTopics: nextRelatedTopics,
    }, db);

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
    removeMemorySearchIndex(memoryId, db);
    clearMemoryEmbedding(memoryId, db);
    return true;
  }

  removeMemorySearchIndex(memoryId, db);
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
    scope?: MemoryScopeFilter;
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
    scope,
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
      project_id AS projectId,
      session_id AS sessionId,
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

  const scopeClause = buildRetrievalScopeClause(scope, params);
  if (scopeClause) {
    query += ` AND (${scopeClause})`;
  }

  query += ` ORDER BY ${getMemoryOrderByColumn(orderBy)} ${normalizedOrder} LIMIT ? OFFSET ?`;
  params.push(normalizedLimit, normalizedOffset);

  const rows = db.prepare(query).all(...params) as MemoryRow[];
  return rows.map(mapMemoryRow);
}

export function clearAllMemories(db: Database.Database = getDatabase()) {
  db.prepare("DELETE FROM memory_search_fts").run();
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
