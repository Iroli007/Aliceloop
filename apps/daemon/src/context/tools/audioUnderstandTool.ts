import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { understandAudioFile } from "../../services/multimodalAnalysisService";

const DEFAULT_SESSION_ID = "default-audio-session";

export function createAudioUnderstandTool(sessionId = DEFAULT_SESSION_ID): ToolSet {
  return {
    audio_understand: tool({
      description:
        "Understand an audio file or voice note from a local path. " +
        "Use this for transcription, concise summaries, spoken-content Q&A, or key moments in uploaded audio clips.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute local path to the audio file"),
        instruction: z
          .string()
          .max(500)
          .optional()
          .describe("Optional goal, question, or analysis instruction for the audio"),
        language: z
          .string()
          .max(16)
          .optional()
          .describe("Optional ISO language hint such as zh, en, ja"),
      }),
      execute: async ({ path, instruction, language }) => {
        const result = await understandAudioFile(sessionId, {
          path,
          instruction,
          language,
        });
        return JSON.stringify(result, null, 2);
      },
    }),
  };
}
