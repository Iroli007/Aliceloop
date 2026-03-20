import { randomUUID } from "node:crypto";
import { upsertMemoryNote } from "./memoryRepository";

interface DistillationInput {
  sessionId: string;
  userMessages: string[];
  assistantResponse: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
}

export async function reflectOnTurn(input: DistillationInput): Promise<void> {
  const { sessionId, toolCalls } = input;

  if (!toolCalls || toolCalls.length === 0) {
    return;
  }

  const fileOps = toolCalls.filter((tc) =>
    ["sandbox_grep", "sandbox_glob", "sandbox_read", "sandbox_write", "sandbox_edit", "sandbox_bash"].includes(tc.name),
  );

  if (fileOps.length > 0) {
    const paths = fileOps
      .flatMap((op) => {
        const args = op.args as Record<string, unknown>;
        if (op.name === "sandbox_bash") {
          const command = args.command as string | undefined;
          if (command === "rm" || command === "rmdir") {
            const bashArgs = (args.args as string[] | undefined) ?? [];
            return bashArgs.filter((a) => a && !a.startsWith("-"));
          }
          return [];
        }
        return [(args.targetPath as string) ?? (args.filePath as string) ?? null];
      })
      .filter(Boolean);

    if (paths.length > 0) {
      const now = new Date().toISOString();
      upsertMemoryNote({
        id: `distill-${randomUUID()}`,
        kind: "learning-pattern",
        title: `File operations in session`,
        content: `Worked with files: ${paths.join(", ")}`,
        source: `session:${sessionId}`,
        updatedAt: now,
      });
    }
  }
}
