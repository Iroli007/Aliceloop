import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { focusOrCreateSettingsWindow } from "./settingsWindow";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const daemonBaseUrl = process.env.ALICELOOP_DAEMON_URL ?? "http://127.0.0.1:3030";
const __dirname = dirname(fileURLToPath(import.meta.url));

const devServerUrl = process.env.ELECTRON_RENDERER_URL;

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
  const GOLDEN_RATIO = 0.618;

  // 上下各留 1/10 边距，窗口高度为屏幕的 8/10
  const height = Math.floor(screenHeight * 0.8);
  // 黄金比例: 高度 / 宽度 = 0.618，所以宽度 = 高度 / 0.618
  const width = Math.max(1120, Math.min(1500, Math.floor(height / GOLDEN_RATIO)));
  // 水平居中
  const x = Math.floor((screenWidth - width) / 2);
  // 顶部留 1/10 边距
  const y = Math.floor(screenHeight * 0.1);

  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 1120,
    minHeight: 760,
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

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
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

ipcMain.handle("dialog:open-project-directories", async () => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(window, {
    properties: ["openDirectory", "multiSelections"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      canceled: true,
      directories: [],
    };
  }

  return {
    canceled: false,
    directories: result.filePaths.map((selectedPath) => ({
      name: basename(selectedPath),
      path: selectedPath,
    })),
  };
});

ipcMain.handle("path:open", async (_event, targetPath: string) => {
  const normalizedPath = targetPath.startsWith("~/") ? join(homedir(), targetPath.slice(2)) : targetPath;
  const error = await shell.openPath(normalizedPath);

  if (error) {
    return {
      ok: false,
      error,
    };
  }

  return {
    ok: true,
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
