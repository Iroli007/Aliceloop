import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ChromeRelayMeta } from "./chromeRelayTypes";
import { ChromeRelayService } from "./chromeRelayService";

type JsonRecord = Record<string, unknown>;

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody) as JsonRecord;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function badRequest(response: ServerResponse, detail: string) {
  writeJson(response, 400, {
    error: "bad_request",
    detail,
  });
}

function internalError(response: ServerResponse, error: unknown) {
  writeJson(response, 500, {
    error: "internal_error",
    detail: error instanceof Error ? error.message : String(error),
  });
}

export class ChromeRelayHttpServer {
  private readonly service: ChromeRelayService;

  private readonly onActivity?: () => void;

  private server: Server | null = null;

  private baseUrl: string | null = null;

  constructor(service: ChromeRelayService, onActivity?: () => void) {
    this.service = service;
    this.onActivity = onActivity;
  }

  getMeta(): ChromeRelayMeta | null {
    if (!this.baseUrl) {
      return null;
    }

    return this.service.getCapability(this.baseUrl);
  }

  getStatus() {
    return {
      browserRelay: this.getMeta()?.browserRelay ?? null,
      attachedTabs: this.service.getAttachedTabCount(),
    };
  }

  async launchChrome() {
    await this.service.launchChrome();
    return this.getStatus();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    this.onActivity?.();
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/health" && request.method === "GET") {
      const meta = this.getMeta();
      writeJson(response, 200, {
        ok: true,
        browserRelay: meta?.browserRelay ?? null,
      });
      return;
    }

    try {
      if (requestUrl.pathname === "/status" && request.method === "GET") {
        writeJson(response, 200, {
          ok: true,
          ...this.getStatus(),
        });
        return;
      }

      if (requestUrl.pathname === "/tabs" && request.method === "GET") {
        writeJson(response, 200, await this.service.listTabs());
        return;
      }

      if (requestUrl.pathname === "/tabs/open" && request.method === "POST") {
        const body = await readJsonBody(request);
        const url = typeof body.url === "string" ? body.url.trim() : undefined;
        const waitUntil = typeof body.waitUntil === "string" ? body.waitUntil : undefined;
        const result = await this.service.openTab(url, waitUntil);
        writeJson(response, 200, result);
        return;
      }

      const tabRouteMatch = requestUrl.pathname.match(/^\/tabs\/([^/]+)\/(navigate|snapshot|click|type|screenshot|media-probe|capture-audio|readable|search-results|read-dom|scroll|eval|back|forward)$/);
      if (tabRouteMatch) {
        const [, tabId, action] = tabRouteMatch;
        if (action === "navigate" && request.method === "POST") {
          const body = await readJsonBody(request);
          const url = typeof body.url === "string" ? body.url.trim() : "";
          if (!url) {
            badRequest(response, "url is required");
            return;
          }

          const waitUntil = typeof body.waitUntil === "string" ? body.waitUntil : undefined;
          writeJson(response, 200, await this.service.navigate(tabId, url, waitUntil));
          return;
        }

        if (action === "snapshot" && request.method === "GET") {
          const maxTextLength = requestUrl.searchParams.get("maxTextLength");
          const maxElements = requestUrl.searchParams.get("maxElements");
          writeJson(
            response,
            200,
            await this.service.snapshot(tabId, {
              maxTextLength: maxTextLength ? Number(maxTextLength) : undefined,
              maxElements: maxElements ? Number(maxElements) : undefined,
            }),
          );
          return;
        }

        if (action === "click" && request.method === "POST") {
          const body = await readJsonBody(request);
          const ref = typeof body.ref === "string" ? body.ref.trim() : "";
          if (!ref) {
            badRequest(response, "ref is required");
            return;
          }

          const waitUntil = typeof body.waitUntil === "string" ? body.waitUntil : undefined;
          writeJson(response, 200, await this.service.click(tabId, ref, waitUntil));
          return;
        }

        if (action === "type" && request.method === "POST") {
          const body = await readJsonBody(request);
          const ref = typeof body.ref === "string" ? body.ref.trim() : "";
          const text = typeof body.text === "string" ? body.text : "";
          if (!ref) {
            badRequest(response, "ref is required");
            return;
          }

          writeJson(response, 200, await this.service.type(tabId, ref, text, body.submit === true));
          return;
        }

        if (action === "screenshot" && request.method === "POST") {
          const body = await readJsonBody(request);
          const outputPath = typeof body.outputPath === "string" ? body.outputPath : undefined;
          const fullPage = body.fullPage !== false;
          const ref = typeof body.ref === "string" ? body.ref : undefined;
          writeJson(response, 200, await this.service.screenshot(tabId, outputPath, fullPage, ref));
          return;
        }

        if (action === "media-probe" && request.method === "GET") {
          const ref = requestUrl.searchParams.get("ref") || undefined;
          writeJson(response, 200, await this.service.mediaProbe(tabId, ref));
          return;
        }

        if (action === "capture-audio" && request.method === "POST") {
          const body = await readJsonBody(request);
          const outputPath = typeof body.outputPath === "string" ? body.outputPath : undefined;
          const ref = typeof body.ref === "string" ? body.ref : undefined;
          const clipMs = typeof body.clipMs === "number" ? body.clipMs : undefined;
          writeJson(response, 200, await this.service.captureAudioClip(tabId, {
            outputPath,
            ref,
            clipMs,
          }));
          return;
        }

        if (action === "readable" && request.method === "GET") {
          const maxTextLength = requestUrl.searchParams.get("maxTextLength");
          const extractMain = requestUrl.searchParams.get("extractMain");
          writeJson(
            response,
            200,
            await this.service.readable(tabId, {
              maxTextLength: maxTextLength ? Number(maxTextLength) : undefined,
              extractMain: extractMain ? extractMain === "true" : undefined,
            }),
          );
          return;
        }

        if (action === "search-results" && request.method === "GET") {
          const maxResults = Number(requestUrl.searchParams.get("maxResults") ?? "5");
          writeJson(response, 200, await this.service.searchResults(tabId, Number.isFinite(maxResults) ? maxResults : 5));
          return;
        }

        if (action === "read-dom" && request.method === "GET") {
          const maxTextLength = requestUrl.searchParams.get("maxTextLength");
          const maxElements = requestUrl.searchParams.get("maxElements");
          writeJson(
            response,
            200,
            await this.service.readDom(tabId, {
              maxTextLength: maxTextLength ? Number(maxTextLength) : undefined,
              maxElements: maxElements ? Number(maxElements) : undefined,
            }),
          );
          return;
        }

        if (action === "scroll" && request.method === "POST") {
          const body = await readJsonBody(request);
          const direction = typeof body.direction === "string" ? body.direction : "down";
          if (!["up", "down", "left", "right"].includes(direction)) {
            badRequest(response, "direction must be one of up/down/left/right");
            return;
          }

          const amount = typeof body.amount === "number" ? body.amount : undefined;
          writeJson(response, 200, await this.service.scroll(tabId, direction as "up" | "down" | "left" | "right", amount));
          return;
        }

        if (action === "eval" && request.method === "POST") {
          const body = await readJsonBody(request);
          const expression = typeof body.expression === "string" ? body.expression : "";
          if (!expression.trim()) {
            badRequest(response, "expression is required");
            return;
          }

          writeJson(response, 200, await this.service.eval(tabId, expression));
          return;
        }

        if (action === "back" && request.method === "POST") {
          const body = await readJsonBody(request);
          const waitUntil = typeof body.waitUntil === "string" ? body.waitUntil : undefined;
          writeJson(response, 200, await this.service.back(tabId, waitUntil));
          return;
        }

        if (action === "forward" && request.method === "POST") {
          const body = await readJsonBody(request);
          const waitUntil = typeof body.waitUntil === "string" ? body.waitUntil : undefined;
          writeJson(response, 200, await this.service.forward(tabId, waitUntil));
          return;
        }
      }

      const closeMatch = requestUrl.pathname.match(/^\/tabs\/([^/]+)$/);
      if (closeMatch && request.method === "DELETE") {
        const [, tabId] = closeMatch;
        await this.service.closeTab(tabId);
        writeJson(response, 200, { ok: true, tabId });
        return;
      }

      writeJson(response, 404, {
        error: "not_found",
      });
    } catch (error) {
      internalError(response, error);
    }
  }

  async start() {
    if (this.server && this.baseUrl) {
      return this.baseUrl;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine Chrome relay server address");
    }

    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this.baseUrl;
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await this.service.dispose().catch(() => undefined);
  }
}
