import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { getStoredRuntimeScriptDefinition, listRuntimeScriptDefinitions } from "../../repositories/runtimeCatalogRepository";
import { runManagedTask } from "../../services/taskRunner";

export function createManagedTaskTools(): ToolSet {
  const tools: ToolSet = {
    document_ingest: tool({
      description: "Ingest a local document into Aliceloop's library and indexing pipeline.",
      inputSchema: z.object({
        sourcePath: z.string().describe("Local filesystem path to the document to ingest"),
        title: z.string().optional().describe("Optional title override for the imported document"),
      }),
      execute: async ({ sourcePath, title }) => {
        const result = await runManagedTask({
          taskType: "document-ingest",
          sourcePath,
          title,
        });
        return JSON.stringify(result);
      },
    }),
    review_coach: tool({
      description: "Create a short review memory or reflection note from the current session context.",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Optional session ID for review context"),
        title: z.string().optional().describe("Optional title override for the review note"),
      }),
      execute: async ({ sessionId, title }) => {
        const result = await runManagedTask({
          taskType: "review-coach",
          sessionId: sessionId ?? null,
          title,
        });
        return JSON.stringify(result);
      },
    }),
  };

  for (const script of listRuntimeScriptDefinitions()) {
    if (script.status !== "available") {
      continue;
    }

    const toolName = `runtime_script_${script.id.replace(/-/g, "_")}`;
    tools[toolName] = tool({
      description: script.description,
      inputSchema: z.object({
        title: z.string().optional().describe("Optional title shown in Aliceloop task history"),
        args: z.array(z.string()).default([]).describe("Additional CLI arguments passed to the runtime script"),
        cwd: z.string().optional().describe("Optional working directory override"),
        sessionId: z.string().optional().describe("Optional session ID for associating the task"),
      }),
      execute: async ({ title, args, cwd, sessionId }) => {
        const runtimeScript = getStoredRuntimeScriptDefinition(script.id);
        if (!runtimeScript || runtimeScript.status !== "available") {
          throw new Error(`Runtime script is unavailable: ${script.id}`);
        }

        const result = await runManagedTask({
          taskType: "script-runner",
          sessionId: sessionId ?? null,
          title: title ?? `运行脚本 · ${runtimeScript.label}`,
          command: runtimeScript.launchCommand,
          args: [...runtimeScript.launchArgsPrefix, runtimeScript.entryPath, ...runtimeScript.defaultArgs, ...args],
          cwd: cwd ?? runtimeScript.defaultCwd,
        });
        return JSON.stringify(result);
      },
    });
  }

  return tools;
}
