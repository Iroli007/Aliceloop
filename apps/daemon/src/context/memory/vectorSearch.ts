export interface ScoredMemory {
  memoryId: string;
  score: number;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dotProduct += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankBySimilarity(
  queryEmbedding: Float32Array,
  memoryEmbeddings: Array<{ memoryId: string; embedding: Float32Array }>,
  limit: number,
  threshold: number,
): ScoredMemory[] {
  return memoryEmbeddings
    .map((memory) => ({
      memoryId: memory.memoryId,
      score: cosineSimilarity(queryEmbedding, memory.embedding),
    }))
    .filter((memory) => Number.isFinite(memory.score) && memory.score >= threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
