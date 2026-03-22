# Alice 记忆系统升级 - 完整实施方案

## 概述

本文档提供 Alice 记忆系统的完整实施细节，包括所有代码实现。

**目标：** 从基础的 FTS5 搜索升级到完整的语义向量记忆系统

**核心功能：**
- 语义向量检索（OpenAI embeddings）
- 配置化管理
- 自动摘要增强
- 记忆统计和管理
- REST API 端点

---

## Phase 1: 数据库 Schema

### 文件：`apps/daemon/src/db/schema.ts`

在 `schemaStatements` 数组末尾添加以下表定义：

```typescript
// 在 schemaStatements 数组中添加：

// 主记忆表
`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('auto', 'manual')),
    durability TEXT NOT NULL CHECK(durability IN ('permanent', 'temporary')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    related_topics TEXT
  )
`,

// 嵌入元数据
`
  CREATE TABLE IF NOT EXISTS memory_metadata (
    memory_id TEXT PRIMARY KEY,
    embedding_model TEXT NOT NULL,
    embedding_dimension INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  )
`,

// 嵌入向量存储
`
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  )
`,

// 配置表
`
  CREATE TABLE IF NOT EXISTS memory_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`,

// 索引
`
  CREATE INDEX IF NOT EXISTS memories_source_idx ON memories(source)
`,
`
  CREATE INDEX IF NOT EXISTS memories_durability_idx ON memories(durability)
`,
`
  CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at DESC)
`,
`
  CREATE INDEX IF NOT EXISTS memories_access_idx ON memories(access_count DESC)
`,
```

**说明：**
- `memories` - 主表，存储记忆内容和元数据
- `memory_embeddings` - 使用 BLOB 存储 Float32Array 向量
- `memory_metadata` - 记录嵌入模型信息
- `memory_config` - 键值对配置存储
- 保留现有的 `memory_notes` 表用于向后兼容

---

## Phase 2: 类型定义

### 文件：`packages/runtime-core/src/domain.ts`

在文件末尾添加：

```typescript
// ============================================================================
// Memory System Types
// ============================================================================

export interface Memory {
  id: string;
  content: string;
  source: 'auto' | 'manual';
  durability: 'permanent' | 'temporary';
  created_at: string;
  updated_at: string;
  access_count: number;
  related_topics: string[];
}

export interface MemoryWithScore extends Memory {
  similarity_score: number;
}

export interface MemoryMetadata {
  memory_id: string;
  embedding_model: string;
  embedding_dimension: number;
  created_at: string;
}

export interface MemoryConfig {
  enabled: boolean;
  autoRetrieval: boolean;
  queryRewrite: boolean;
  maxRetrievalCount: number;
  similarityThreshold: number;
  autoSummarize: boolean;
  embeddingModel: 'text-embedding-3-small' | 'text-embedding-3-large';
  embeddingDimension: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  autoRetrieval: true,
  queryRewrite: false,
  maxRetrievalCount: 10,
  similarityThreshold: 0.7,
  autoSummarize: true,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimension: 1536,
};

export interface MemoryStats {
  total_count: number;
  auto_count: number;
  manual_count: number;
  permanent_count: number;
  temporary_count: number;
  total_access_count: number;
  avg_access_count: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

export interface CreateMemoryInput {
  content: string;
  source: 'auto' | 'manual';
  durability: 'permanent' | 'temporary';
  related_topics?: string[];
}

export interface UpdateMemoryInput {
  content?: string;
  durability?: 'permanent' | 'temporary';
  related_topics?: string[];
}
```

---

## Phase 3: 嵌入服务

### 新文件：`apps/daemon/src/context/memory/embeddingService.ts`

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateEmbedding(
  text: string,
  model: 'text-embedding-3-small' | 'text-embedding-3-large' = 'text-embedding-3-small'
): Promise<Float32Array> {
  const response = await openai.embeddings.create({
    model,
    input: text,
  });
  return new Float32Array(response.data[0].embedding);
}

export async function generateEmbeddingsBatch(
  texts: string[],
  model: 'text-embedding-3-small' | 'text-embedding-3-large' = 'text-embedding-3-small'
): Promise<Float32Array[]> {
  const response = await openai.embeddings.create({
    model,
    input: texts,
  });
  return response.data.map(d => new Float32Array(d.embedding));
}

export function serializeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer);
}

export function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
```

**依赖：** 确保 `openai` 包已安装

---

## Phase 4: 向量检索

### 新文件：`apps/daemon/src/context/memory/vectorSearch.ts`

```typescript
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredMemory {
  memory_id: string;
  score: number;
}

export function rankBySimilarity(
  queryEmbedding: Float32Array,
  memoryEmbeddings: Array<{ memory_id: string; embedding: Float32Array }>,
  limit: number,
  threshold: number
): ScoredMemory[] {
  const scored = memoryEmbeddings.map(m => ({
    memory_id: m.memory_id,
    score: cosineSimilarity(queryEmbedding, m.embedding),
  }));

  return scored
    .filter(s => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

---

## Phase 5: 配置管理

### 新文件：`apps/daemon/src/context/memory/memoryConfig.ts`

```typescript
import type { Database } from 'better-sqlite3';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '@aliceloop/runtime-core';

export async function getMemoryConfig(db: Database): Promise<MemoryConfig> {
  const rows = db.prepare('SELECT key, value FROM memory_config').all() as Array<{
    key: string;
    value: string;
  }>;

  if (rows.length === 0) {
    await initializeConfig(db);
    return DEFAULT_MEMORY_CONFIG;
  }

  const config: any = { ...DEFAULT_MEMORY_CONFIG };
  for (const row of rows) {
    const value = JSON.parse(row.value);
    config[row.key] = value;
  }

  return config as MemoryConfig;
}

export async function updateMemoryConfig(
  db: Database,
  updates: Partial<MemoryConfig>
): Promise<void> {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO memory_config (key, value) VALUES (?, ?)'
  );

  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, JSON.stringify(value));
  }
}

async function initializeConfig(db: Database): Promise<void> {
  await updateMemoryConfig(db, DEFAULT_MEMORY_CONFIG);
}
```

---

## Phase 6: 记忆仓库增强

### 文件：`apps/daemon/src/context/memory/memoryRepository.ts`

在现有文件中添加以下函数（保留现有的 memory_notes 函数）：

```typescript
import { nanoid } from 'nanoid';
import type { Database } from 'better-sqlite3';
import type { Memory, MemoryWithScore, MemoryStats, CreateMemoryInput, UpdateMemoryInput } from '@aliceloop/runtime-core';
import { generateEmbedding, serializeEmbedding, deserializeEmbedding } from './embeddingService';
import { rankBySimilarity } from './vectorSearch';
import { getMemoryConfig } from './memoryConfig';

export async function createMemory(
  db: Database,
  input: CreateMemoryInput
): Promise<Memory> {
  const id = nanoid();
  const now = new Date().toISOString();
  const config = await getMemoryConfig(db);

  const memory: Memory = {
    id,
    content: input.content,
    source: input.source,
    durability: input.durability,
    created_at: now,
    updated_at: now,
    access_count: 0,
    related_topics: input.related_topics || [],
  };

  db.prepare(`
    INSERT INTO memories (id, content, source, durability, created_at, updated_at, access_count, related_topics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.content,
    memory.source,
    memory.durability,
    memory.created_at,
    memory.updated_at,
    memory.access_count,
    JSON.stringify(memory.related_topics)
  );

  // Generate and store embedding
  try {
    const embedding = await generateEmbedding(input.content, config.embeddingModel);
    const blob = serializeEmbedding(embedding);

    db.prepare('INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)').run(
      memory.id,
      blob
    );

    db.prepare(`
      INSERT INTO memory_metadata (memory_id, embedding_model, embedding_dimension, created_at)
      VALUES (?, ?, ?, ?)
    `).run(memory.id, config.embeddingModel, config.embeddingDimension, now);
  } catch (error) {
    console.error('Failed to generate embedding:', error);
  }

  return memory;
}

export async function searchMemoriesBySimilarity(
  db: Database,
  queryText: string,
  limit: number,
  threshold: number
): Promise<MemoryWithScore[]> {
  const config = await getMemoryConfig(db);
  const queryEmbedding = await generateEmbedding(queryText, config.embeddingModel);

  const rows = db.prepare('SELECT memory_id, embedding FROM memory_embeddings').all() as Array<{
    memory_id: string;
    embedding: Buffer;
  }>;

  const memoryEmbeddings = rows.map(r => ({
    memory_id: r.memory_id,
    embedding: deserializeEmbedding(r.embedding),
  }));

  const scored = rankBySimilarity(queryEmbedding, memoryEmbeddings, limit, threshold);

  const memories: MemoryWithScore[] = [];
  for (const s of scored) {
    const row = db.prepare(`
      SELECT id, content, source, durability, created_at, updated_at, access_count, related_topics
      FROM memories WHERE id = ?
    `).get(s.memory_id) as any;

    if (row) {
      memories.push({
        id: row.id,
        content: row.content,
        source: row.source,
        durability: row.durability,
        created_at: row.created_at,
        updated_at: row.updated_at,
        access_count: row.access_count,
        related_topics: JSON.parse(row.related_topics || '[]'),
        similarity_score: s.score,
      });
    }
  }

  return memories;
}

export function incrementAccessCount(db: Database, memoryId: string): void {
  db.prepare('UPDATE memories SET access_count = access_count + 1 WHERE id = ?').run(memoryId);
}

export function getMemoryStats(db: Database): MemoryStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_count,
      SUM(CASE WHEN source = 'auto' THEN 1 ELSE 0 END) as auto_count,
      SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) as manual_count,
      SUM(CASE WHEN durability = 'permanent' THEN 1 ELSE 0 END) as permanent_count,
      SUM(CASE WHEN durability = 'temporary' THEN 1 ELSE 0 END) as temporary_count,
      SUM(access_count) as total_access_count,
      AVG(access_count) as avg_access_count,
      MIN(created_at) as oldest_memory,
      MAX(created_at) as newest_memory
    FROM memories
  `).get() as any;

  return row;
}

export function getMemoryById(db: Database, id: string): Memory | null {
  const row = db.prepare(`
    SELECT id, content, source, durability, created_at, updated_at, access_count, related_topics
    FROM memories WHERE id = ?
  `).get(id) as any;

  if (!row) return null;

  return {
    ...row,
    related_topics: JSON.parse(row.related_topics || '[]'),
  };
}

export function updateMemory(
  db: Database,
  id: string,
  updates: UpdateMemoryInput
): void {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.durability !== undefined) {
    fields.push('durability = ?');
    values.push(updates.durability);
  }
  if (updates.related_topics !== undefined) {
    fields.push('related_topics = ?');
    values.push(JSON.stringify(updates.related_topics));
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteMemory(db: Database, id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function listMemories(
  db: Database,
  options: {
    limit?: number;
    offset?: number;
    source?: 'auto' | 'manual';
    durability?: 'permanent' | 'temporary';
    orderBy?: 'created_at' | 'updated_at' | 'access_count';
    order?: 'ASC' | 'DESC';
  } = {}
): Memory[] {
  const {
    limit = 50,
    offset = 0,
    source,
    durability,
    orderBy = 'created_at',
    order = 'DESC',
  } = options;

  let query = 'SELECT * FROM memories WHERE 1=1';
  const params: any[] = [];

  if (source) {
    query += ' AND source = ?';
    params.push(source);
  }
  if (durability) {
    query += ' AND durability = ?';
    params.push(durability);
  }

  query += ` ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(r => ({
    ...r,
    related_topics: JSON.parse(r.related_topics || '[]'),
  }));
}

export function clearAllMemories(db: Database): void {
  db.prepare('DELETE FROM memories').run();
}

export async function rebuildAllEmbeddings(db: Database): Promise<void> {
  const config = await getMemoryConfig(db);
  const memories = db.prepare('SELECT id, content FROM memories').all() as Array<{
    id: string;
    content: string;
  }>;

  for (const memory of memories) {
    const embedding = await generateEmbedding(memory.content, config.embeddingModel);
    const blob = serializeEmbedding(embedding);

    db.prepare('INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)').run(
      memory.id,
      blob
    );

    db.prepare(`
      INSERT OR REPLACE INTO memory_metadata (memory_id, embedding_model, embedding_dimension, created_at)
      VALUES (?, ?, ?, ?)
    `).run(memory.id, config.embeddingModel, config.embeddingDimension, new Date().toISOString());
  }
}
```

---

## Phase 7: 自动摘要增强

### 文件：`apps/daemon/src/context/memory/memoryDistiller.ts`

增强现有的 `reflectOnTurn` 函数，添加对话内容分析：

```typescript
// 在现有文件中添加新函数

import type { Database } from 'better-sqlite3';
import { createMemory } from './memoryRepository';
import { getMemoryConfig } from './memoryConfig';

interface ExtractedMemory {
  content: string;
  durability: 'permanent' | 'temporary';
  related_topics: string[];
}

export async function extractMemoriesFromConversation(
  db: Database,
  userMessage: string,
  assistantMessage: string,
  llmClient: any // 你的 LLM 客户端
): Promise<void> {
  const config = await getMemoryConfig(db);
  if (!config.enabled || !config.autoSummarize) {
    return;
  }

  const prompt = `分析以下对话，提取值得长期记住的信息。

用户消息：
${userMessage}

助手回复：
${assistantMessage}

请提取以下类型的信息：
1. 用户偏好和习惯（例如："用户喜欢使用 TypeScript"）
2. 项目相关知识（例如："这个项目使用 Vite 作为构建工具"）
3. 重要决策和原因（例如："决定使用 PostgreSQL 因为需要关系型数据"）
4. 技术细节和解决方案（例如："修复了 CORS 问题通过添加代理配置"）

输出 JSON 数组格式：
[
  {
    "content": "记忆内容",
    "durability": "permanent" 或 "temporary",
    "related_topics": ["主题1", "主题2"]
  }
]

如果没有值得记住的信息，返回空数组 []。`;

  try {
    const response = await llmClient.chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const extracted: ExtractedMemory[] = JSON.parse(response.content);

    for (const mem of extracted) {
      await createMemory(db, {
        content: mem.content,
        source: 'auto',
        durability: mem.durability,
        related_topics: mem.related_topics,
      });
    }
  } catch (error) {
    console.error('Failed to extract memories:', error);
  }
}
```

**集成点：** 在对话处理流程中调用此函数

---

## Phase 8: 查询重写（可选）

### 新文件：`apps/daemon/src/context/memory/queryRewriter.ts`

```typescript
export async function rewriteQuery(
  originalQuery: string,
  llmClient: any
): Promise<string> {
  const prompt = `优化以下查询以提高记忆检索准确率。

原始查询：${originalQuery}

请：
1. 扩展关键词
2. 添加同义词
3. 使查询更具体

只返回优化后的查询文本，不要解释。`;

  const response = await llmClient.chat({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  return response.content.trim();
}
```

---

## Phase 9: 上下文集成

### 文件：`apps/daemon/src/context/memory/memoryContext.ts`

增强 `buildMemoryBlock` 函数：

```typescript
import type { Database } from 'better-sqlite3';
import { getMemoryConfig } from './memoryConfig';
import { searchMemoriesBySimilarity, incrementAccessCount } from './memoryRepository';
import { rewriteQuery } from './queryRewriter';

export async function buildMemoryBlock(
  db: Database,
  sessionId: string,
  userQuery?: string
): Promise<string> {
  const config = await getMemoryConfig(db);

  if (!config.enabled || !config.autoRetrieval || !userQuery) {
    return '';
  }

  try {
    let query = userQuery;

    // 查询重写（可选）
    if (config.queryRewrite) {
      query = await rewriteQuery(query, /* llmClient */);
    }

    // 向量检索
    const memories = await searchMemoriesBySimilarity(
      db,
      query,
      config.maxRetrievalCount,
      config.similarityThreshold
    );

    if (memories.length === 0) {
      return '';
    }

    // 更新访问计数
    for (const memory of memories) {
      incrementAccessCount(db, memory.id);
    }

    // 格式化输出
    const lines = [
      '<relevant_memories>',
      '以下是相关的记忆信息：',
      '',
    ];

    for (const mem of memories) {
      lines.push(`- ${mem.content} (相似度: ${mem.similarity_score.toFixed(2)})`);
      if (mem.related_topics.length > 0) {
        lines.push(`  主题: ${mem.related_topics.join(', ')}`);
      }
    }

    lines.push('</relevant_memories>');
    return lines.join('\n');
  } catch (error) {
    console.error('Failed to build memory block:', error);
    return '';
  }
}
```

---

## Phase 10: API 端点

### 文件：`apps/daemon/src/server.ts`

在现有的 Express 服务器中添加以下路由：

```typescript
import {
  getMemoryConfig,
  updateMemoryConfig,
  createMemory,
  searchMemoriesBySimilarity,
  getMemoryStats,
  getMemoryById,
  updateMemory,
  deleteMemory,
  listMemories,
  clearAllMemories,
  rebuildAllEmbeddings,
} from './context/memory';

// 配置管理
app.get('/api/memory/config', async (req, res) => {
  try {
    const config = await getMemoryConfig(db);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get config' });
  }
});

app.put('/api/memory/config', async (req, res) => {
  try {
    await updateMemoryConfig(db, req.body);
    const config = await getMemoryConfig(db);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// 统计
app.get('/api/memory/stats', (req, res) => {
  try {
    const stats = getMemoryStats(db);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// 重建嵌入
app.post('/api/memory/rebuild', async (req, res) => {
  try {
    await rebuildAllEmbeddings(db);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rebuild embeddings' });
  }
});

// 列出记忆
app.get('/api/memories', (req, res) => {
  try {
    const options = {
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
      source: req.query.source as 'auto' | 'manual' | undefined,
      durability: req.query.durability as 'permanent' | 'temporary' | undefined,
      orderBy: req.query.orderBy as 'created_at' | 'updated_at' | 'access_count' | undefined,
      order: req.query.order as 'ASC' | 'DESC' | undefined,
    };
    const memories = listMemories(db, options);
    res.json(memories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list memories' });
  }
});

// 创建记忆
app.post('/api/memories', async (req, res) => {
  try {
    const memory = await createMemory(db, req.body);
    res.status(201).json(memory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create memory' });
  }
});

// 搜索记忆
app.get('/api/memories/search', async (req, res) => {
  try {
    const q = req.query.q as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const threshold = req.query.threshold ? parseFloat(req.query.threshold as string) : 0.7;

    const memories = await searchMemoriesBySimilarity(db, q, limit, threshold);
    res.json(memories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to search memories' });
  }
});

// 获取单个记忆
app.get('/api/memories/:id', (req, res) => {
  try {
    const memory = getMemoryById(db, req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get memory' });
  }
});

// 更新记忆
app.put('/api/memories/:id', (req, res) => {
  try {
    updateMemory(db, req.params.id, req.body);
    const memory = getMemoryById(db, req.params.id);
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

// 删除记忆
app.delete('/api/memories/:id', (req, res) => {
  try {
    deleteMemory(db, req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// 清空所有记忆
app.delete('/api/memories/clear', (req, res) => {
  try {
    clearAllMemories(db);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear memories' });
  }
});
```

---

## Phase 11: 工具集成

### 新文件：`apps/daemon/src/context/tools/memoryTools.ts`

```typescript
import type { Database } from 'better-sqlite3';
import { createMemory, searchMemoriesBySimilarity, updateMemory } from '../memory/memoryRepository';

export const memoryTools = [
  {
    name: 'add_memory',
    description: '手动添加一条记忆。用于保存重要信息供未来参考。',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '记忆内容',
        },
        durability: {
          type: 'string',
          enum: ['permanent', 'temporary'],
          description: 'permanent=长期保存, temporary=临时保存',
        },
        related_topics: {
          type: 'array',
          items: { type: 'string' },
          description: '相关主题标签',
        },
      },
      required: ['content', 'durability'],
    },
  },
  {
    name: 'search_memories',
    description: '搜索相关记忆。使用语义向量检索找到最相关的记忆。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询',
        },
        limit: {
          type: 'number',
          description: '返回结果数量（默认10）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_memory',
    description: '更新现有记忆的内容或属性。',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: '记忆ID',
        },
        content: {
          type: 'string',
          description: '新的内容',
        },
        durability: {
          type: 'string',
          enum: ['permanent', 'temporary'],
          description: '新的持久性',
        },
        related_topics: {
          type: 'array',
          items: { type: 'string' },
          description: '新的主题标签',
        },
      },
      required: ['memory_id'],
    },
  },
];

export async function executeMemoryTool(
  db: Database,
  toolName: string,
  input: any
): Promise<any> {
  switch (toolName) {
    case 'add_memory':
      return await createMemory(db, {
        content: input.content,
        source: 'manual',
        durability: input.durability,
        related_topics: input.related_topics,
      });

    case 'search_memories':
      return await searchMemoriesBySimilarity(
        db,
        input.query,
        input.limit || 10,
        0.7
      );

    case 'update_memory':
      updateMemory(db, input.memory_id, {
        content: input.content,
        durability: input.durability,
        related_topics: input.related_topics,
      });
      return { success: true };

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

### 文件：`apps/daemon/src/context/tools/toolRegistry.ts`

在工具注册表中添加记忆工具：

```typescript
import { memoryTools } from './memoryTools';

// 在现有工具数组中添加
export const allTools = [
  ...existingTools,
  ...memoryTools,
];
```

---

## 验证测试

### 1. 创建记忆

```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "content": "用户喜欢使用 TypeScript 进行开发",
    "source": "manual",
    "durability": "permanent",
    "related_topics": ["TypeScript", "偏好"]
  }'
```

### 2. 向量检索

```bash
curl "http://localhost:3000/api/memories/search?q=TypeScript偏好&limit=5"
```

### 3. 获取配置

```bash
curl http://localhost:3000/api/memory/config
```

### 4. 更新配置

```bash
curl -X PUT http://localhost:3000/api/memory/config \
  -H "Content-Type: application/json" \
  -d '{
    "maxRetrievalCount": 15,
    "similarityThreshold": 0.8
  }'
```

### 5. 获取统计

```bash
curl http://localhost:3000/api/memory/stats
```

### 6. 列出记忆（分页）

```bash
curl "http://localhost:3000/api/memories?limit=20&offset=0&orderBy=access_count&order=DESC"
```

### 7. 更新记忆

```bash
curl -X PUT http://localhost:3000/api/memories/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "durability": "permanent",
    "related_topics": ["TypeScript", "偏好", "开发"]
  }'
```

### 8. 删除记忆

```bash
curl -X DELETE http://localhost:3000/api/memories/{id}
```

### 9. 重建嵌入

```bash
curl -X POST http://localhost:3000/api/memory/rebuild
```

---

## 技术决策说明

### 1. 嵌入存储方案：BLOB vs vec0

**选择：BLOB**

理由：
- 无需安装额外的 SQLite 扩展
- 更通用，跨平台兼容性好
- 手动实现余弦相似度简单高效
- 对于中小规模记忆（<10,000条）性能足够
- 避免依赖外部扩展的维护问题

**性能考虑：**
- 全表扫描计算相似度，时间复杂度 O(n)
- 对于 10,000 条记忆，检索时间约 100-200ms
- 如果未来需要优化，可以考虑：
  - 使用 HNSW 索引
  - 迁移到 vec0 或 pgvector
  - 实现分层检索

### 2. 嵌入模型选择

**默认：text-embedding-3-small**

参数：
- 维度：1536
- 成本：$0.02 / 1M tokens
- 速度：快

**可选：text-embedding-3-large**

参数：
- 维度：3072
- 成本：$0.13 / 1M tokens
- 精度：更高

**切换方式：**
```bash
curl -X PUT http://localhost:3000/api/memory/config \
  -d '{"embeddingModel": "text-embedding-3-large", "embeddingDimension": 3072}'

curl -X POST http://localhost:3000/api/memory/rebuild
```

### 3. 向后兼容策略

**保留 memory_notes 表：**
- 现有功能不受影响
- 新功能作为增强，不破坏现有代码
- 可以逐步迁移数据

**迁移脚本（可选）：**
```typescript
async function migrateFromMemoryNotes(db: Database) {
  const oldNotes = db.prepare('SELECT * FROM memory_notes').all();
  
  for (const note of oldNotes) {
    await createMemory(db, {
      content: note.content,
      source: 'manual',
      durability: 'permanent',
      related_topics: [note.kind],
    });
  }
}
```

### 4. 降级策略

**OpenAI API 失败时：**
```typescript
export async function searchMemoriesBySimilarity(
  db: Database,
  queryText: string,
  limit: number,
  threshold: number
): Promise<MemoryWithScore[]> {
  try {
    // 尝试向量检索
    const config = await getMemoryConfig(db);
    const queryEmbedding = await generateEmbedding(queryText, config.embeddingModel);
    // ... 向量检索逻辑
  } catch (error) {
    console.error('Vector search failed, falling back to FTS:', error);
    // 降级到 FTS5 搜索
    return fallbackToFTSSearch(db, queryText, limit);
  }
}

function fallbackToFTSSearch(
  db: Database,
  query: string,
  limit: number
): MemoryWithScore[] {
  // 使用现有的 memory_notes_fts 或创建新的 FTS 索引
  const rows = db.prepare(`
    SELECT m.*, 0.5 as similarity_score
    FROM memories m
    WHERE m.content LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
  
  return rows.map(r => ({
    ...r,
    related_topics: JSON.parse(r.related_topics || '[]'),
  }));
}
```

---

## 实施步骤指南

### Step 1: 环境准备

1. 确保安装 OpenAI SDK：
```bash
npm install openai
```

2. 配置环境变量：
```bash
export OPENAI_API_KEY="your-api-key"
```

### Step 2: 数据库迁移

1. 修改 `apps/daemon/src/db/schema.ts`
2. 重启应用，自动创建新表
3. 验证表创建：
```bash
sqlite3 your-database.db ".schema memories"
```

### Step 3: 核心功能实现

按以下顺序创建文件：
1. `embeddingService.ts` - 嵌入生成
2. `vectorSearch.ts` - 向量检索
3. `memoryConfig.ts` - 配置管理
4. `memoryRepository.ts` - 数据访问层

### Step 4: 集成测试

1. 创建测试记忆
2. 测试向量检索
3. 验证配置读写
4. 检查统计数据

### Step 5: API 集成

1. 添加 API 路由到 `server.ts`
2. 测试所有端点
3. 验证错误处理

### Step 6: 工具集成

1. 创建 `memoryTools.ts`
2. 注册到工具系统
3. 测试 AI 调用工具

### Step 7: 自动摘要集成

1. 增强 `memoryDistiller.ts`
2. 在对话流程中集成
3. 测试自动提取

---

## 注意事项

### 1. 性能优化

**批量操作：**
- 使用 `generateEmbeddingsBatch` 批量生成嵌入
- 使用事务处理批量插入

```typescript
db.transaction(() => {
  for (const memory of memories) {
    // 插入操作
  }
})();
```

**缓存策略：**
- 缓存配置对象，避免频繁读取
- 考虑使用 LRU 缓存热门记忆

### 2. 错误处理

**OpenAI API 失败：**
- 实现重试机制（指数退避）
- 降级到 FTS 搜索
- 记录错误日志

**数据库错误：**
- 使用事务保证一致性
- 外键约束确保数据完整性

### 3. 安全考虑

**API 认证：**
- 添加认证中间件
- 限制敏感操作（清空、重建）

**输入验证：**
- 验证所有用户输入
- 防止 SQL 注入（使用参数化查询）
- 限制内容长度

### 4. 监控和日志

**关键指标：**
- 记忆总数
- 检索延迟
- API 调用成功率
- 嵌入生成失败率

**日志记录：**
```typescript
console.log('[Memory] Created:', memoryId);
console.log('[Memory] Search query:', query, 'results:', count);
console.error('[Memory] Embedding failed:', error);
```

---

## 优化建议

### 1. 未来扩展

**向量索引优化：**
- 当记忆数量 > 10,000 时，考虑使用 HNSW 索引
- 可选方案：迁移到 pgvector（PostgreSQL）

**分布式存储：**
- 使用 Redis 缓存热门记忆
- 使用专用向量数据库（Pinecone, Weaviate）

### 2. 高级功能

**记忆聚类：**
```typescript
// 使用 K-means 对记忆进行聚类
export function clusterMemories(embeddings: Float32Array[], k: number) {
  // 实现 K-means 算法
}
```

**记忆衰减：**
```typescript
// 根据时间和访问频率计算记忆权重
export function calculateMemoryWeight(memory: Memory): number {
  const daysSinceCreated = daysBetween(memory.created_at, now());
  const decayFactor = Math.exp(-daysSinceCreated / 30);
  return memory.access_count * decayFactor;
}
```

**记忆合并：**
```typescript
// 合并相似的记忆，避免冗余
export async function mergeSimilarMemories(db: Database, threshold: number) {
  // 找到相似度 > threshold 的记忆对
  // 合并内容，保留访问计数
}
```

### 3. 用户界面

**记忆管理面板：**
- 可视化记忆分布
- 主题标签云
- 访问热力图
- 记忆时间线

**记忆编辑器：**
- 批量编辑标签
- 记忆导入/导出
- 记忆搜索过滤

---

## 实施优先级总结

### P0 - 核心功能（必须实现）

**预计时间：2-3 天**

1. ✅ 数据库 Schema（Phase 1）
2. ✅ 类型定义（Phase 2）
3. ✅ 嵌入服务（Phase 3）
4. ✅ 向量检索（Phase 4）
5. ✅ 配置管理（Phase 5）
6. ✅ 记忆仓库（Phase 6）

**验收标准：**
- 可以创建记忆并生成嵌入
- 可以进行语义检索
- 配置可读写

### P1 - 重要功能（建议实现）

**预计时间：1-2 天**

7. ✅ 自动摘要（Phase 7）
8. ✅ 上下文集成（Phase 9）
9. ✅ API 端点（Phase 10）
10. ✅ 工具集成（Phase 11）

**验收标准：**
- 对话自动提取记忆
- 记忆自动注入上下文
- API 完整可用
- AI 可调用记忆工具

### P2 - 优化功能（可选实现）

**预计时间：1 天**

11. ⭕ 查询重写（Phase 8）
12. ⭕ 记忆聚类
13. ⭕ 记忆衰减
14. ⭕ 高级过滤

**验收标准：**
- 检索准确率提升
- 记忆自动整理

---

## 常见问题 FAQ

### Q1: 如何处理 OpenAI API 配额限制？

**A:** 实现速率限制和批量处理：

```typescript
import pLimit from 'p-limit';

const limit = pLimit(5); // 最多5个并发请求

export async function batchGenerateEmbeddings(texts: string[]) {
  const chunks = chunkArray(texts, 100); // 每批100个
  const results = [];
  
  for (const chunk of chunks) {
    const embeddings = await limit(() => generateEmbeddingsBatch(chunk));
    results.push(...embeddings);
    await sleep(1000); // 限速
  }
  
  return results;
}
```

### Q2: 如何迁移现有的 memory_notes 数据？

**A:** 运行迁移脚本：

```typescript
async function migrateMemoryNotes(db: Database) {
  const oldNotes = db.prepare('SELECT * FROM memory_notes').all();
  
  console.log(`Migrating ${oldNotes.length} notes...`);
  
  for (const note of oldNotes) {
    await createMemory(db, {
      content: `${note.title}\n${note.content}`,
      source: 'manual',
      durability: 'permanent',
      related_topics: [note.kind],
    });
  }
  
  console.log('Migration complete');
}
```

### Q3: 如何优化大量记忆的检索性能？

**A:** 使用分层检索策略：

```typescript
export async function hybridSearch(
  db: Database,
  query: string,
  limit: number
): Promise<MemoryWithScore[]> {
  // 第一层：FTS 快速过滤
  const candidates = db.prepare(`
    SELECT m.id FROM memories m
    WHERE m.content LIKE ?
    LIMIT 100
  `).all(`%${query}%`);
  
  // 第二层：向量精确排序
  const candidateIds = candidates.map(c => c.id);
  const embeddings = db.prepare(`
    SELECT memory_id, embedding FROM memory_embeddings
    WHERE memory_id IN (${candidateIds.map(() => '?').join(',')})
  `).all(...candidateIds);
  
  // 计算相似度并排序
  const queryEmbedding = await generateEmbedding(query);
  return rankBySimilarity(queryEmbedding, embeddings, limit, 0.7);
}
```

### Q4: 如何防止记忆过多导致上下文污染？

**A:** 实现智能过滤：

```typescript
export async function buildMemoryBlock(
  db: Database,
  sessionId: string,
  userQuery?: string
): Promise<string> {
  const config = await getMemoryConfig(db);
  const memories = await searchMemoriesBySimilarity(db, userQuery, 20, 0.7);
  
  // 去重：移除内容相似的记忆
  const deduplicated = deduplicateMemories(memories, 0.95);
  
  // 限制总长度
  const filtered = filterByTotalLength(deduplicated, 2000);
  
  // 只返回最相关的
  return formatMemoryBlock(filtered.slice(0, config.maxRetrievalCount));
}
```

### Q5: 如何处理多语言记忆？

**A:** OpenAI embeddings 原生支持多语言，无需特殊处理。但可以添加语言标签：

```typescript
await createMemory(db, {
  content: 'User prefers TypeScript',
  source: 'auto',
  durability: 'permanent',
  related_topics: ['TypeScript', 'preference', 'lang:en'],
});
```

---

## 完整文件清单

### 需要修改的文件

1. **`apps/daemon/src/db/schema.ts`**
   - 添加 4 个新表：memories, memory_metadata, memory_embeddings, memory_config
   - 添加索引

2. **`packages/runtime-core/src/domain.ts`**
   - 添加类型定义：Memory, MemoryConfig, MemoryStats 等

3. **`apps/daemon/src/context/memory/memoryRepository.ts`**
   - 添加新函数：createMemory, searchMemoriesBySimilarity 等
   - 保留现有的 memory_notes 函数

4. **`apps/daemon/src/context/memory/memoryContext.ts`**
   - 增强 buildMemoryBlock 函数

5. **`apps/daemon/src/context/memory/memoryDistiller.ts`**
   - 添加 extractMemoriesFromConversation 函数

6. **`apps/daemon/src/server.ts`**
   - 添加 11 个 API 端点

7. **`apps/daemon/src/context/tools/toolRegistry.ts`**
   - 注册记忆工具

### 需要创建的文件

1. **`apps/daemon/src/context/memory/embeddingService.ts`** (新建)
   - 嵌入生成和序列化

2. **`apps/daemon/src/context/memory/vectorSearch.ts`** (新建)
   - 余弦相似度和排序

3. **`apps/daemon/src/context/memory/memoryConfig.ts`** (新建)
   - 配置读写

4. **`apps/daemon/src/context/memory/queryRewriter.ts`** (新建，可选)
   - 查询优化

5. **`apps/daemon/src/context/tools/memoryTools.ts`** (新建)
   - AI 工具定义

---

## 依赖项

### NPM 包

```json
{
  "dependencies": {
    "openai": "^4.0.0",
    "nanoid": "^5.0.0",
    "better-sqlite3": "^9.0.0"
  },
  "devDependencies": {
    "p-limit": "^5.0.0"
  }
}
```

### 环境变量

```bash
# .env
OPENAI_API_KEY=sk-...
```

---

## 数据库大小估算

**单条记忆存储：**
- 记忆内容：平均 200 字节
- 嵌入向量（1536维）：6,144 字节
- 元数据：约 100 字节
- **总计：约 6.5 KB/条**

**容量规划：**
- 1,000 条记忆：约 6.5 MB
- 10,000 条记忆：约 65 MB
- 100,000 条记忆：约 650 MB

---

## 成本估算

**OpenAI Embedding API：**
- text-embedding-3-small: $0.02 / 1M tokens
- 平均每条记忆 50 tokens
- **1,000 条记忆：约 $0.001**
- **10,000 条记忆：约 $0.01**

**检索成本：**
- 每次检索需要生成查询嵌入
- 平均查询 20 tokens
- **1,000 次检索：约 $0.0004**

---

## 总结

本方案提供了完整的语义记忆系统实现，包括：

✅ **核心功能**
- 语义向量检索（OpenAI embeddings）
- 配置化管理
- 自动摘要提取
- 记忆统计

✅ **技术特点**
- 使用 BLOB 存储向量，无需外部扩展
- 向后兼容现有 memory_notes
- 降级策略保证可用性
- RESTful API 完整

✅ **实施路径**
- P0 核心功能：2-3 天
- P1 重要功能：1-2 天
- P2 优化功能：1 天
- **总计：4-6 天**

✅ **可扩展性**
- 支持 10,000+ 记忆
- 可升级到专用向量数据库
- 支持高级功能扩展

---

## 下一步行动

1. **立即开始：** 实施 P0 核心功能
2. **测试验证：** 使用提供的 curl 命令测试
3. **监控观察：** 收集性能和使用数据
4. **迭代优化：** 根据实际使用情况调整

**祝实施顺利！** 🚀

