import { createReadStream } from "node:fs";
import type { ReadTextFileWindowResult } from "./types";

export async function readTextWindow(
  targetPath: string,
  offset: number,
  limit: number,
): Promise<ReadTextFileWindowResult> {
  const startLine = Math.max(0, offset);
  const maxLines = Math.max(1, limit);
  const endLineExclusive = startLine + maxLines;
  const stream = createReadStream(targetPath, {
    encoding: "utf8",
  });

  let buffer = "";
  let totalLines = 0;
  let sawChunk = false;
  let endedWithNewline = false;
  const windowLines: string[] = [];

  const consumeLine = (line: string) => {
    if (totalLines >= startLine && totalLines < endLineExclusive) {
      windowLines.push(line);
    }
    totalLines += 1;
  };

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!text) {
      continue;
    }

    sawChunk = true;
    buffer += text;
    endedWithNewline = text.endsWith("\n");

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer.length > 0 || !sawChunk || endedWithNewline) {
    consumeLine(buffer);
  }

  return {
    content: windowLines.join("\n"),
    totalLines,
  };
}
