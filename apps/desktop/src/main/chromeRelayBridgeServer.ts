import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

export class ChromeRelayBridgeServer {
  private readonly port: number;

  private token = randomUUID();

  private server: Server | null = null;

  private wss: WebSocketServer | null = null;

  private clients = new Set<WebSocket>();

  private attachedTabs = new Set<string>();

  constructor(port = 23001) {
    this.port = port;
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
        token: this.token,
        visible: true,
        healthy: this.clients.size > 0,
      },
      attachedTabs: this.attachedTabs.size,
    };
  }

  getMeta(): BrowserRelayStatus {
    return this.getStatus();
  }

  regenerateToken(): BrowserRelayStatus {
    this.token = randomUUID();
    this.broadcast({
      type: "config",
      port: this.port,
      token: this.token,
    });
    return this.getStatus();
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
    let message: { type?: unknown; attachedTabs?: unknown };
    try {
      const text = typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part))).toString("utf8")
            : Buffer.from(raw).toString("utf8");
      message = JSON.parse(text) as { type?: unknown; attachedTabs?: unknown };
    } catch {
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

  private handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", this.httpBaseUrl);

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
        token: this.token,
        wsBaseUrl: this.wsBaseUrl,
      });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
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
      if (requestUrl.pathname !== "/ws/browser-relay" || requestUrl.searchParams.get("token") !== this.token) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    });

    wss.on("connection", (client: WebSocket) => {
      this.clients.add(client);
      client.on("message", (raw: RawData) => {
        this.handleWsMessage(client, raw);
      });
      client.on("close", () => {
        this.clients.delete(client);
        if (this.clients.size === 0) {
          this.attachedTabs.clear();
        }
      });
      client.on("error", () => undefined);
      client.send(JSON.stringify({
        type: "config",
        port: this.port,
        token: this.token,
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
