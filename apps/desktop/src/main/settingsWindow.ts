import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

let settingsWindow: BrowserWindow | null = null;
const devServerUrl = process.env.ELECTRON_RENDERER_URL;

export function createSettingsWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const baseHeight = Math.max(720, Math.min(860, Math.floor(screenHeight * 0.74)));
  const height = Math.floor(baseHeight * 0.8);
  const width = Math.max(960, Math.min(1160, Math.floor(baseHeight * 1.28)));
  const x = Math.floor((screenWidth - width) / 2) + 36;
  const y = Math.max(24, Math.floor((screenHeight - height) / 2) - 20);

  settingsWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 900,
    minHeight: 544,
    title: "设置",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  // Ensure window is shown immediately
  settingsWindow.show();

  if (process.platform === "darwin") {
    settingsWindow.setWindowButtonVisibility(true);
  }

  if (devServerUrl) {
    settingsWindow.loadURL(`${devServerUrl}/settings/index.html?surface=settings`);
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
