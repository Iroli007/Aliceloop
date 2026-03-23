import type { MemoryEmbeddingModel } from "@aliceloop/runtime-core";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EMBEDDING_CACHE_TTL_MS = parsePositiveInt(process.env.ALICELOOP_EMBEDDING_CACHE_TTL_MS, 10 * 60 * 1000);
const EMBEDDING_CACHE_MAX_ENTRIES = parsePositiveInt(process.env.ALICELOOP_EMBEDDING_CACHE_MAX_ENTRIES, 256);
const EMBEDDING_BREAKER_COOLDOWN_MS = parsePositiveInt(process.env.ALICELOOP_EMBEDDING_BREAKER_COOLDOWN_MS, 2 * 60 * 1000);
const EMBEDDING_BREAKER_TIMEOUT_THRESHOLD = parsePositiveInt(process.env.ALICELOOP_EMBEDDING_BREAKER_TIMEOUT_THRESHOLD, 2);
const EMBEDDING_BREAKER_FAILURE_THRESHOLD = parsePositiveInt(process.env.ALICELOOP_EMBEDDING_BREAKER_FAILURE_THRESHOLD, 3);

interface EmbeddingCacheEntry {
  embedding: Float32Array;
  expiresAt: number;
}

type EmbeddingFailureKind = "timeout" | "error";

const embeddingCache = new Map<string, EmbeddingCacheEntry>();

let consecutiveTimeouts = 0;
let consecutiveFailures = 0;
let circuitOpenedAtMs = 0;
let circuitOpenUntilMs = 0;
let lastFailureKind: EmbeddingFailureKind | null = null;

function getCacheKey(text: string, model: MemoryEmbeddingModel, dimension: number) {
  return `${model}:${dimension}:${text.trim()}`;
}

function pruneExpiredCacheEntries(now = Date.now()) {
  for (const [key, entry] of embeddingCache.entries()) {
    if (entry.expiresAt <= now) {
      embeddingCache.delete(key);
    }
  }

  while (embeddingCache.size > EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldestKey = embeddingCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    embeddingCache.delete(oldestKey);
  }
}

function ensureBreakerFresh(now = Date.now()) {
  if (circuitOpenUntilMs !== 0 && circuitOpenUntilMs <= now) {
    circuitOpenedAtMs = 0;
    circuitOpenUntilMs = 0;
    consecutiveTimeouts = 0;
    consecutiveFailures = 0;
    lastFailureKind = null;
  }
}

function openCircuit(now: number) {
  circuitOpenedAtMs = now;
  circuitOpenUntilMs = now + EMBEDDING_BREAKER_COOLDOWN_MS;
}

export function getCachedQueryEmbedding(
  text: string,
  model: MemoryEmbeddingModel,
  dimension: number,
) {
  pruneExpiredCacheEntries();
  const entry = embeddingCache.get(getCacheKey(text, model, dimension));
  if (!entry) {
    return null;
  }

  return entry.embedding.slice();
}

export function cacheQueryEmbedding(
  text: string,
  model: MemoryEmbeddingModel,
  dimension: number,
  embedding: Float32Array,
) {
  pruneExpiredCacheEntries();
  embeddingCache.set(getCacheKey(text, model, dimension), {
    embedding: embedding.slice(),
    expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS,
  });
}

export function getEmbeddingCircuitState() {
  const now = Date.now();
  ensureBreakerFresh(now);
  return {
    open: circuitOpenUntilMs > now,
    openUntilMs: circuitOpenUntilMs || null,
    cooldownRemainingMs: circuitOpenUntilMs > now ? circuitOpenUntilMs - now : 0,
    openedAtMs: circuitOpenedAtMs || null,
    consecutiveTimeouts,
    consecutiveFailures,
    lastFailureKind,
  };
}

export function recordEmbeddingSuccess() {
  consecutiveTimeouts = 0;
  consecutiveFailures = 0;
  circuitOpenedAtMs = 0;
  circuitOpenUntilMs = 0;
  lastFailureKind = null;
}

export function recordEmbeddingFailure(kind: EmbeddingFailureKind) {
  const now = Date.now();
  ensureBreakerFresh(now);

  consecutiveFailures += 1;
  if (kind === "timeout") {
    consecutiveTimeouts += 1;
  } else {
    consecutiveTimeouts = 0;
  }

  lastFailureKind = kind;

  if (
    consecutiveTimeouts >= EMBEDDING_BREAKER_TIMEOUT_THRESHOLD
    || consecutiveFailures >= EMBEDDING_BREAKER_FAILURE_THRESHOLD
  ) {
    openCircuit(now);
  }
}
