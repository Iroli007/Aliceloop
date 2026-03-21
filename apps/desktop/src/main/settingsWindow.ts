import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

let settingsWindow: BrowserWindow | null = null;
const devServerUrl = process.env.ELECTRON_RENDERER_URL;

export function createSettingsWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const width = 700;
  const height = 500;
  // Position slightly offset from center so it's visible
  const x = Math.floor((screenWidth - width) / 2) + 50;
  const y = Math.floor((screenHeight - height) / 2) - 50;

  settingsWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    title: "设置",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Ensure window is shown immediately
  settingsWindow.show();

  if (process.platform === "darwin") {
    settingsWindow.setWindowButtonVisibility(true);
  }

  if (devServerUrl) {
    settingsWindow.loadURL(`${devServerUrl}/settings.html?surface=settings`);
  } else {
    settingsWindow.loadFile(join(__dirname, "../renderer/settings/index.html"), {
      query: { surface: "settings" },
    });
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

export function focusOrCreateSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  return createSettingsWindow();
}
