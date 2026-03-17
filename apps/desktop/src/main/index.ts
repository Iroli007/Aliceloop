import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const daemonBaseUrl = process.env.ALICELOOP_DAEMON_URL ?? "http://127.0.0.1:3030";
const __dirname = dirname(fileURLToPath(import.meta.url));

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
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
