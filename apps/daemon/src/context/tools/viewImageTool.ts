import { tool, type ToolSet } from "ai";
import { resolve } from "node:path";
import { z } from "zod";
import { describeImageFile } from "../../services/multimodalAnalysisService";

const DEFAULT_SESSION_ID = "default-image-session";
const DEFAULT_IMAGE_PROMPT =
  "Read and analyze this image faithfully. Focus on visible text, layout, interactive UI regions, bottom bars, input boxes, send/publish/comment buttons, and the user's question. If this looks like a product screenshot, point out the most likely next click or typing target. Do not guess unreadable details.";

export function createViewImageTool(sessionId = DEFAULT_SESSION_ID): ToolSet {
  return {
    view_image: tool({
      description:
        "Read and analyze a local image file from an absolute path. Use this for screenshots, photos, OCR-like questions, and uploaded image attachments.",
      inputSchema: z.object({
        imagePath: z.string().min(1).describe("Absolute local path to the image file"),
        prompt: z
          .string()
          .max(800)
          .optional()
          .describe("Optional analysis prompt or question"),
      }),
      execute: async ({ imagePath, prompt }) => {
        const resolvedPath = resolve(imagePath);
        const analysisPrompt = prompt?.trim() || DEFAULT_IMAGE_PROMPT;
        const result = await describeImageFile(sessionId, {
          path: resolvedPath,
          prompt: analysisPrompt,
          allowInternalPath: true,
        });

        return JSON.stringify(
          {
            imagePath: resolvedPath,
            prompt: analysisPrompt,
            ...result,
          },
          null,
          2,
        );
      },
    }),
  };
}
