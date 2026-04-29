import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { getMemoryById, incrementAccessCount, listMemoryProjectionRecords } from "../memory/memoryRepository";
import { ensureMemoryFileProjection, readMemoryTopicFile } from "../memory/memoryFileProtocol";

export function createMemoryTool(): ToolSet {
  return {
    memory_get: tool({
      description: "Fetch the full content for a retrieved long-term memory by id. Use this only when a Retrieved Memories manifest is relevant but the title/description are not enough.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Memory id from the Retrieved Memories manifest"),
      }),
      execute: async ({ id }) => {
        const memoryId = id.trim();
        ensureMemoryFileProjection(listMemoryProjectionRecords());
        const topicMemory = readMemoryTopicFile(memoryId);
        if (topicMemory) {
          incrementAccessCount(memoryId);
          return JSON.stringify({
            id: topicMemory.id,
            type: topicMemory.memoryType,
            title: topicMemory.title,
            description: topicMemory.description,
            content: topicMemory.content,
            updatedAt: topicMemory.updatedAt,
          });
        }

        const memory = getMemoryById(memoryId);
        if (!memory) {
          throw new Error(`Memory not found: ${memoryId}`);
        }

        incrementAccessCount(memoryId);
        return JSON.stringify({
          id: memory.id,
          type: memory.memoryType,
          title: memory.title,
          description: memory.description,
          content: memory.content,
          updatedAt: memory.updatedAt,
        });
      },
    }),
  };
}
