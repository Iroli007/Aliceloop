import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { BrowserRelayCapability } from "@aliceloop/runtime-core";

type BrowserRelayStatus = {
  browserRelay: BrowserRelayCapability | null;
  attachedTabs: number;
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
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

  return JSON.parse(rawBody) as Record<string, unknown>;
}

function ensureDirectoryForFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeBase64File(targetPath: string, dataBase64: string) {
  ensureDirectoryForFile(targetPath);
  writeFileSync(targetPath, Buffer.from(dataBase64, "base64"));
}

function parseTabId(value: string) {
  const tabId = Number(value);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Invalid tab id: ${value}`);
  }

  return tabId;
}

export class ChromeRelayBridgeServer {
  private readonly port: number;

  private readonly onActivity?: () => void;

  private server: Server | null = null;

  private wss: WebSocketServer | null = null;

  private clients = new Set<WebSocket>();

  private activeClient: WebSocket | null = null;

  private attachedTabs = new Set<string>();

  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(port = 23001, onActivity?: () => void) {
    this.port = port;
    this.onActivity = onActivity;
  }

  private get wsBaseUrl() {
    return `ws://127.0.0.1:${this.port}/ws/browser-relay`;
  }

  private get httpBaseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  private getStatus(): BrowserRelayStatus {
    return {
      browserRelay: {
        enabled: true,
        backend: "desktop_chrome",
        baseUrl: this.httpBaseUrl,
        visible: true,
        healthy: this.clients.size > 0,
      },
      attachedTabs: this.attachedTabs.size,
    };
  }

  getMeta(): BrowserRelayStatus {
    return this.getStatus();
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
    const client = this.activeClient;
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new Error("No Chrome Relay extension is connected.");
    }

    const id = `relay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Chrome Relay command timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      client.send(JSON.stringify({
        id,
        method,
        params,
      }));
    });
  }

  private broadcast(payload: Record<string, unknown>) {
    const message = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private handleWsMessage(client: WebSocket, raw: RawData) {
    this.onActivity?.();
    let message: { type?: unknown; attachedTabs?: unknown; id?: unknown; error?: unknown; result?: unknown };
    try {
      const text = typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part))).toString("utf8")
            : Buffer.from(raw).toString("utf8");
      message = JSON.parse(text) as { type?: unknown; attachedTabs?: unknown; id?: unknown; error?: unknown; result?: unknown };
    } catch {
      return;
    }

    if (typeof message.id === "string") {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(String(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.type === "ping") {
      client.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (message.type === "status" && Array.isArray(message.attachedTabs)) {
      this.attachedTabs = new Set(
        message.attachedTabs
          .filter((value) => value !== null && value !== undefined)
          .map((value) => String(value)),
      );
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    this.onActivity?.();
    const requestUrl = new URL(request.url ?? "/", this.httpBaseUrl);

    try {
      if (requestUrl.pathname === "/health" && request.method === "GET") {
        writeJson(response, 200, {
          ok: true,
          browserRelay: this.getStatus().browserRelay,
          attachedTabs: this.attachedTabs.size,
        });
        return;
      }

      if (requestUrl.pathname === "/api/browser-relay/config" && request.method === "GET") {
        writeJson(response, 200, {
          port: this.port,
          wsBaseUrl: this.wsBaseUrl,
        });
        return;
      }

      if (requestUrl.pathname === "/status" && request.method === "GET") {
        writeJson(response, 200, {
          ok: true,
          ...this.getStatus(),
        });
        return;
      }

      if (requestUrl.pathname === "/tabs" && request.method === "GET") {
        const rawTabs = await this.sendCommand("tabs.list");
        if (Array.isArray(rawTabs)) {
          const tabs = rawTabs
            .map((tab) => {
              if (!tab || typeof tab !== "object") {
                return null;
              }

              const record = tab as Record<string, unknown>;
              const tabId = typeof record.id === "number" || typeof record.id === "string"
                ? String(record.id)
                : typeof record.tabId === "number" || typeof record.tabId === "string"
                  ? String(record.tabId)
                  : null;
              if (!tabId) {
                return null;
              }

              return {
                tabId,
                url: typeof record.url === "string" ? record.url : "",
                title: typeof record.title === "string" ? record.title : null,
                active: record.active === true,
              };
            })
            .filter((tab): tab is { tabId: string; url: string; title: string | null; active: boolean } => tab !== null);

          writeJson(response, 200, {
            backend: "desktop_chrome",
            activeTabId: tabs.find((tab) => tab.active)?.tabId ?? null,
            tabs,
          });
          return;
        }

        writeJson(response, 200, rawTabs);
        return;
      }

      if (requestUrl.pathname === "/tabs/open" && request.method === "POST") {
        const body = await readJsonBody(request);
        writeJson(response, 200, await this.sendCommand("tabs.create", {
          url: typeof body.url === "string" ? body.url.trim() : undefined,
          active: body.active !== false,
        }));
        return;
      }

      const tabRouteMatch = requestUrl.pathname.match(/^\/tabs\/([^/]+)\/(navigate|snapshot|click|type|screenshot|media-probe|capture-audio|readable|search-results|read-dom|scroll|eval|back|forward)$/);
      if (tabRouteMatch) {
        const [, tabId, action] = tabRouteMatch;
        if (action === "navigate" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.navigate", {
            tabId: parseTabId(tabId),
            url: typeof body.url === "string" ? body.url.trim() : "",
            waitUntil: typeof body.waitUntil === "string" ? body.waitUntil : undefined,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "snapshot" && request.method === "GET") {
          const result = await this.sendCommand("tabs.snapshot", {
            tabId: parseTabId(tabId),
            maxTextLength: requestUrl.searchParams.get("maxTextLength")
              ? Number(requestUrl.searchParams.get("maxTextLength"))
              : undefined,
            maxElements: requestUrl.searchParams.get("maxElements")
              ? Number(requestUrl.searchParams.get("maxElements"))
              : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "click" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.click", {
            tabId: parseTabId(tabId),
            ref: typeof body.ref === "string" ? body.ref.trim() : "",
            waitUntil: typeof body.waitUntil === "string" ? body.waitUntil : undefined,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "type" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.type", {
            tabId: parseTabId(tabId),
            ref: typeof body.ref === "string" ? body.ref.trim() : "",
            text: typeof body.text === "string" ? body.text : "",
            submit: body.submit === true,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "screenshot" && request.method === "POST") {
          const body = await readJsonBody(request);
          const targetPath = typeof body.outputPath === "string" && body.outputPath.trim()
            ? body.outputPath.trim()
            : join(process.cwd(), "browser-screenshots", `aliceloop-browser-${Date.now()}-${tabId}.png`);
          const result = await this.sendCommand("tabs.screenshot", {
            tabId: parseTabId(tabId),
            ref: typeof body.ref === "string" ? body.ref.trim() : undefined,
            fullPage: body.fullPage !== false,
          }) as { dataUrl?: string; url?: string };
          const dataUrl = typeof result.dataUrl === "string" ? result.dataUrl : "";
          const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
          if (!base64) {
            throw new Error("Chrome relay did not return screenshot data.");
          }
          writeBase64File(targetPath, base64);
          writeJson(response, 200, {
            path: targetPath,
            url: typeof result.url === "string" ? result.url : this.httpBaseUrl,
            backend: "desktop_chrome",
            tabId,
          });
          return;
        }

        if (action === "media-probe" && request.method === "GET") {
          const result = await this.sendCommand("tabs.mediaProbe", {
            tabId: parseTabId(tabId),
            ref: requestUrl.searchParams.get("ref") || undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "capture-audio" && request.method === "POST") {
          const body = await readJsonBody(request);
          const targetPath = typeof body.outputPath === "string" && body.outputPath.trim()
            ? body.outputPath.trim()
            : join(process.cwd(), "browser-watch-audio", `aliceloop-browser-audio-${Date.now()}-${tabId}.webm`);
          const result = await this.sendCommand("tabs.captureAudioClip", {
            tabId: parseTabId(tabId),
            ref: typeof body.ref === "string" ? body.ref.trim() : undefined,
            clipMs: typeof body.clipMs === "number" ? body.clipMs : undefined,
          }) as { dataBase64?: string; mediaType?: string | null; ref?: string | null; currentTime?: number | null; limitation?: string | null; url?: string };
          if (typeof result.dataBase64 === "string" && result.dataBase64) {
            writeBase64File(targetPath, result.dataBase64);
          }
          writeJson(response, 200, {
            path: typeof result.dataBase64 === "string" && result.dataBase64 ? targetPath : null,
            mediaType: result.mediaType ?? null,
            url: typeof result.url === "string" ? result.url : this.httpBaseUrl,
            backend: "desktop_chrome",
            tabId,
            ref: result.ref ?? null,
            currentTime: result.currentTime ?? null,
            durationMs: typeof body.clipMs === "number" ? body.clipMs : 10000,
            limitation: result.limitation ?? null,
          });
          return;
        }

        if (action === "readable" && request.method === "GET") {
          const result = await this.sendCommand("tabs.readable", {
            tabId: parseTabId(tabId),
            maxTextLength: requestUrl.searchParams.get("maxTextLength")
              ? Number(requestUrl.searchParams.get("maxTextLength"))
              : undefined,
            extractMain: requestUrl.searchParams.get("extractMain")
              ? requestUrl.searchParams.get("extractMain") === "true"
              : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "search-results" && request.method === "GET") {
          const result = await this.sendCommand("tabs.searchResults", {
            tabId: parseTabId(tabId),
            maxResults: Number(requestUrl.searchParams.get("maxResults") ?? "5"),
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "read-dom" && request.method === "GET") {
          const result = await this.sendCommand("tabs.readDom", {
            tabId: parseTabId(tabId),
            maxTextLength: requestUrl.searchParams.get("maxTextLength")
              ? Number(requestUrl.searchParams.get("maxTextLength"))
              : undefined,
            maxElements: requestUrl.searchParams.get("maxElements")
              ? Number(requestUrl.searchParams.get("maxElements"))
              : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "scroll" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.scroll", {
            tabId: parseTabId(tabId),
            direction: typeof body.direction === "string" ? body.direction : "down",
            amount: typeof body.amount === "number" ? body.amount : undefined,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "eval" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.eval", {
            tabId: parseTabId(tabId),
            expression: typeof body.expression === "string" ? body.expression : "",
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "back" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.back", {
            tabId: parseTabId(tabId),
            waitUntil: typeof body.waitUntil === "string" ? body.waitUntil : undefined,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }

        if (action === "forward" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await this.sendCommand("tabs.forward", {
            tabId: parseTabId(tabId),
            waitUntil: typeof body.waitUntil === "string" ? body.waitUntil : undefined,
            maxTextLength: typeof body.maxTextLength === "number" ? body.maxTextLength : undefined,
            maxElements: typeof body.maxElements === "number" ? body.maxElements : undefined,
          });
          writeJson(response, 200, result);
          return;
        }
      }

      const closeMatch = requestUrl.pathname.match(/^\/tabs\/([^/]+)$/);
      if (closeMatch && request.method === "DELETE") {
        const [, tabId] = closeMatch;
        const result = await this.sendCommand("tabs.close", { tabId: parseTabId(tabId) });
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 500, {
        error: "internal_error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async start() {
    if (this.server) {
      return this.httpBaseUrl;
    }

    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", this.httpBaseUrl);
      if (requestUrl.pathname !== "/ws/browser-relay") {
        socket.destroy();
        return;
      }

      this.onActivity?.();
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    });

    wss.on("connection", (client: WebSocket) => {
      this.onActivity?.();
      this.clients.add(client);
      this.activeClient = client;
      client.on("message", (raw: RawData) => {
        this.handleWsMessage(client, raw);
      });
      client.on("close", () => {
        this.clients.delete(client);
        if (this.activeClient === client) {
          this.activeClient = null;
        }
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error("Chrome Relay extension disconnected."));
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
        }
        if (this.clients.size === 0) {
          this.attachedTabs.clear();
        }
      });
      client.on("error", () => undefined);
      client.send(JSON.stringify({
        type: "config",
        port: this.port,
      }));
      client.send(JSON.stringify({
        type: "status",
        attachedTabs: [...this.attachedTabs],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.wss = wss;
    return this.httpBaseUrl;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.wss?.close();
    this.wss = null;
    this.clients.clear();
    this.attachedTabs.clear();

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
