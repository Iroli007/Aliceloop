import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const daemonBaseUrl = process.env.ALICELOOP_DAEMON_URL ?? "http://127.0.0.1:3030";
const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenHeightToWidthRatio = 0.618;
const defaultWindowHeight = Math.round(920 * 0.9);
const defaultWindowWidth = Math.round(defaultWindowHeight / goldenHeightToWidthRatio);

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
  const window = new BrowserWindow({
    width: defaultWindowWidth,
    height: defaultWindowHeight,
    minWidth: 1120,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (!app.isPackaged && rendererUrl) {
    window.loadURL(rendererUrl);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

function getTargetWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
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
  const window = getTargetWindow();
  const result = await dialog.showOpenDialog(window, {
    buttonLabel: "上传",
    properties: ["openFile", "openDirectory", "multiSelections"],
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

ipcMain.handle("window:minimize", () => {
  const window = getTargetWindow();
  window?.minimize();
});

ipcMain.handle("window:toggle-maximize", () => {
  const window = getTargetWindow();
  if (!window) {
    return;
  }

  if (window.isMaximized()) {
    window.unmaximize();
    return;
  }

  window.maximize();
});

app.whenReady().then(() => {
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
