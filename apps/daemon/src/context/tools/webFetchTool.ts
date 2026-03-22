import { z } from "zod";
import { tool } from "ai";
import TurndownService from "turndown";

const MAX_CONTENT_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Strip noisy elements before conversion
turndown.remove(["script", "style", "nav", "footer", "iframe", "noscript"]);

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[… truncated at ${limit} characters]`;
}

/**
 * Try to extract <main> or <article> from raw HTML.
 * Falls back to full <body> if neither exists.
 */
function extractMainContent(html: string): string {
  // Simple regex extraction — good enough without a full DOM parser
  for (const tag of ["main", "article"]) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = html.match(regex);
    if (match) return match[0];
  }

  // Fallback: strip everything outside <body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[0] : html;
}

export function createWebFetchTool() {
  return {
    web_fetch: tool({
      description:
        "Fetch the content of a public URL and return it as readable text. " +
        "HTML pages are converted to Markdown with boilerplate removed. " +
        "JSON and plain text are returned as-is. " +
        "Use this when a task requires inspecting a known URL (docs page, API response, article, release notes).",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to fetch"),
        extractMain: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), extract <main>/<article> content and strip nav/footer/scripts"),
        maxLength: z
          .number()
          .int()
          .min(1000)
          .max(MAX_CONTENT_LENGTH)
          .optional()
          .default(MAX_CONTENT_LENGTH)
          .describe(`Maximum characters to return (default ${MAX_CONTENT_LENGTH})`),
      }),
      execute: async ({ url, extractMain, maxLength }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Aliceloop/1.0 (web_fetch tool)",
              Accept: "text/html, application/json, text/plain, */*",
            },
            redirect: "follow",
          });

          if (!response.ok) {
            return JSON.stringify({
              error: `HTTP ${response.status} ${response.statusText}`,
              url,
            });
          }

          const contentType = response.headers.get("content-type") ?? "";
          const rawBody = await response.text();

          // JSON — return as-is
          if (contentType.includes("application/json")) {
            return truncate(rawBody, maxLength);
          }

          // Plain text — return as-is
          if (contentType.includes("text/plain")) {
            return truncate(rawBody, maxLength);
          }

          // HTML — extract and convert to Markdown
          const htmlChunk = extractMain ? extractMainContent(rawBody) : rawBody;
          const markdown = turndown.turndown(htmlChunk);
          return truncate(markdown, maxLength);
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return JSON.stringify({
              error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
              url,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          return JSON.stringify({ error: message, url });
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}
