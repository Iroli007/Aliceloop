import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { focusOrCreateSettingsWindow } from "./settingsWindow";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const daemonBaseUrl = process.env.ALICELOOP_DAEMON_URL ?? "http://127.0.0.1:3030";
const __dirname = dirname(fileURLToPath(import.meta.url));

const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const debugCaptureEnabled = process.env.ALICELOOP_DEBUG_CAPTURE === "1";
const HEARTBEAT_INTERVAL_MS = 10_000;
let desktopHeartbeatTimer: NodeJS.Timeout | null = null;

async function getStableDesktopDeviceId() {
  const filePath = join(app.getPath("userData"), "desktop-device-id");

  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Fall through and create one.
  }

  const next = `desktop-${randomUUID()}`;
  await writeFile(filePath, next, "utf8");
  return next;
}

async function sendDesktopHeartbeat() {
  const deviceId = await getStableDesktopDeviceId();

  await fetch(`${daemonBaseUrl}/api/runtime/presence/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deviceId,
      deviceType: "desktop",
      label: "Aliceloop Desktop",
    }),
  });
}

function startDesktopHeartbeatLoop() {
  const tick = async () => {
    try {
      await sendDesktopHeartbeat();
    } catch {
      // Keep desktop usable even when daemon heartbeat fails.
    }
  };

  void tick();
  desktopHeartbeatTimer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildRendererLoadErrorPage(input: {
  heading: string;
  detail: string;
  target: string;
}) {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Aliceloop</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #edf2fb;
        color: #1f2937;
      }
      main {
        width: min(560px, calc(100vw - 48px));
        padding: 28px 30px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.22);
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 22px;
        line-height: 1.2;
      }
      p {
        margin: 0 0 12px;
        font-size: 14px;
        line-height: 1.65;
        color: #516072;
      }
      code {
        display: block;
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #f8fbff;
        border: 1px dashed rgba(148, 163, 184, 0.4);
        font-family: "SFMono-Regular", Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        color: #334155;
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.heading)}</h1>
      <p>${escapeHtml(input.detail)}</p>
      <p>先确认 renderer dev server 和 daemon 都在运行，然后再重新打开桌面端。</p>
      <code>${escapeHtml(input.target)}</code>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

type DesktopPickedFile = {
  kind: "file";
  name: string;
  path: string;
  mimeType: string;
  contentBase64: string;
};

type DesktopPickedFolder = {
  kind: "folder";
  name: string;
  path: string;
  files: Array<{
    name: string;
    relativePath: string;
    mimeType: string;
    contentBase64: string;
  }>;
};

function guessMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".js":
      return "text/javascript";
    case ".ts":
      return "text/typescript";
    case ".tsx":
      return "text/tsx";
    case ".jsx":
      return "text/jsx";
    case ".py":
      return "text/x-python";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".yml":
    case ".yaml":
      return "text/yaml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function serializeFile(filePath: string): Promise<DesktopPickedFile> {
  const content = await readFile(filePath);
  return {
    kind: "file",
    name: basename(filePath),
    path: filePath,
    mimeType: guessMimeType(filePath),
    contentBase64: content.toString("base64"),
  };
}

async function collectFolderFiles(folderPath: string): Promise<DesktopPickedFolder["files"]> {
  const files: DesktopPickedFolder["files"] = [];

  async function visit(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const content = await readFile(entryPath);
      files.push({
        name: entry.name,
        relativePath: relative(folderPath, entryPath).replace(/\\/g, "/"),
        mimeType: guessMimeType(entryPath),
        contentBase64: content.toString("base64"),
      });
    }
  }

  await visit(folderPath);
  return files;
}

function createWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const WINDOW_HEIGHT_TO_WIDTH_RATIO = 3 / 4;

  const baseHeight = Math.floor(screenHeight * 0.8);
  const baseWidth = Math.max(1120, Math.min(1500, Math.floor(baseHeight / WINDOW_HEIGHT_TO_WIDTH_RATIO)));
  const width = Math.max(900, Math.min(1440, Math.floor(baseWidth * 0.75)));
  const height = Math.max(675, Math.floor(width * WINDOW_HEIGHT_TO_WIDTH_RATIO));
  const x = Math.floor((screenWidth - width) / 2);
  const y = Math.floor((screenHeight - height) / 2);

  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    minWidth: 900,
    minHeight: 675,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  if (process.platform === "darwin") {
    window.setWindowButtonVisibility(false);
  }

  let revealed = false;
  let showingRendererError = false;

  const revealWindow = () => {
    if (revealed || window.isDestroyed()) {
      return;
    }
    revealed = true;
    window.show();
  };

  let debugCaptureTimer: NodeJS.Timeout | null = null;

  const scheduleDebugCapture = () => {
    if (!debugCaptureEnabled || debugCaptureTimer || window.isDestroyed()) {
      return;
    }

    debugCaptureTimer = setTimeout(async () => {
      debugCaptureTimer = null;
      if (window.isDestroyed()) {
        return;
      }

      try {
        await mkdir(join(process.cwd(), "tmp"), { recursive: true });
        const image = await window.webContents.capturePage();
        const outputPath = join(process.cwd(), "tmp", "electron-window-capture.png");
        await writeFile(outputPath, image.toPNG());
        console.info("[aliceloop-desktop] window capture saved", JSON.stringify({ outputPath }));
      } catch (error) {
        console.error("[aliceloop-desktop] window capture failed", error);
      }
    }, 1800);
  };

  const showRendererLoadError = (detail: string, target: string) => {
    if (showingRendererError || window.isDestroyed()) {
      return;
    }

    showingRendererError = true;
    console.error("[aliceloop-desktop] renderer load failed", JSON.stringify({ detail, target }));
    void window.loadURL(buildRendererLoadErrorPage({
      heading: "桌面端页面加载失败",
      detail,
      target,
    }));
    revealWindow();
  };

  window.once("ready-to-show", revealWindow);
  window.webContents.on("did-finish-load", () => {
    console.info("[aliceloop-desktop] renderer loaded", JSON.stringify({
      url: window.webContents.getURL(),
    }));
    revealWindow();
    scheduleDebugCapture();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }

    showRendererLoadError(`did-fail-load (${errorCode}): ${errorDescription}`, validatedURL || devServerUrl || "renderer/index.html");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[aliceloop-desktop] render process gone", JSON.stringify(details));
  });
  window.on("unresponsive", () => {
    console.error("[aliceloop-desktop] window became unresponsive");
  });
  window.on("closed", () => {
    if (debugCaptureTimer) {
      clearTimeout(debugCaptureTimer);
      debugCaptureTimer = null;
    }
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl).catch((error) => {
      showRendererLoadError(
        error instanceof Error ? error.message : "Unknown renderer load error",
        devServerUrl,
      );
    });
  } else {
    const rendererEntry = join(__dirname, "../renderer/index.html");
    void window.loadFile(rendererEntry).catch((error) => {
      showRendererLoadError(
        error instanceof Error ? error.message : "Unknown renderer load error",
        rendererEntry,
      );
    });
  }

  return window;
}

ipcMain.handle("app:get-meta", () => ({
  daemonBaseUrl,
  name: app.getName(),
  version: app.getVersion(),
}));

ipcMain.handle("runtime:ping", async () => {
  try {
    const response = await fetch(`${daemonBaseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Daemon responded with ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to reach daemon",
    };
  }
});

ipcMain.handle("dialog:open-file-or-folder", async () => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  let properties: Array<"openFile" | "openDirectory" | "multiSelections"> = ["openFile", "openDirectory", "multiSelections"];

  if (process.platform === "darwin") {
    const choice = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["打开文件", "打开文件夹", "取消"],
      defaultId: 0,
      cancelId: 2,
      message: "选择要上传的内容",
      detail: "macOS 的原生打开面板在文件和文件夹混选时，对文件夹选择不稳定。这里先明确选择类型，再进入系统对话框。",
    });

    if (choice.response === 2) {
      return {
        canceled: true,
        entries: [],
      };
    }

    properties = choice.response === 1
      ? ["openDirectory", "multiSelections"]
      : ["openFile", "multiSelections"];
  }

  const result = await dialog.showOpenDialog(window, {
    properties,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      canceled: true,
      entries: [],
    };
  }

  const entries: Array<DesktopPickedFile | DesktopPickedFolder> = [];
  for (const selectedPath of result.filePaths) {
    const selectedStat = await stat(selectedPath);
    if (selectedStat.isDirectory()) {
      entries.push({
        kind: "folder",
        name: basename(selectedPath),
        path: selectedPath,
        files: await collectFolderFiles(selectedPath),
      });
      continue;
    }

    entries.push(await serializeFile(selectedPath));
  }

  return {
    canceled: false,
    entries,
  };
});

ipcMain.handle("path:open", async (_event, targetPath: string) => {
  const normalizedPath = targetPath.startsWith("~/") ? join(homedir(), targetPath.slice(2)) : targetPath;
  const error = await shell.openPath(normalizedPath);

  return {
    ok: !error,
    error: error || undefined,
  };
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:toggle-fullscreen", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return;
  }

  if (process.platform === "darwin") {
    window.setFullScreen(!window.isFullScreen());
    return;
  }

  if (window.isMaximized()) {
    window.unmaximize();
    return;
  }

  window.maximize();
});

ipcMain.handle("window:open-settings", () => {
  focusOrCreateSettingsWindow();
});

app.whenReady().then(() => {
  startDesktopHeartbeatLoop();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (desktopHeartbeatTimer) {
    clearInterval(desktopHeartbeatTimer);
    desktopHeartbeatTimer = null;
  }
});
