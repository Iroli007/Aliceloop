import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

let chromeRelayWindow: BrowserWindow | null = null;
const devServerUrl = process.env.ELECTRON_RENDERER_URL;

export function createChromeRelayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const baseHeight = Math.max(720, Math.min(900, Math.floor(screenHeight * 0.8)));
  const width = Math.max(980, Math.min(1320, Math.floor(baseHeight * 1.12)));
  const height = Math.max(680, Math.min(screenHeight - 48, Math.floor(width * 0.78)));
  const x = Math.floor((screenWidth - width) / 2) + 28;
  const y = Math.max(24, Math.floor((screenHeight - height) / 2) - 12);

  chromeRelayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 920,
    minHeight: 620,
    title: "Chrome Relay",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#edf2fb",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  chromeRelayWindow.show();

  if (process.platform === "darwin") {
    chromeRelayWindow.setWindowButtonVisibility(true);
  }

  if (devServerUrl) {
    chromeRelayWindow.loadURL(`${devServerUrl}/chrome-relay/index.html?surface=chrome-relay`);
  } else {
    chromeRelayWindow.loadFile(join(__dirname, "../renderer/chrome-relay/index.html"), {
      query: { surface: "chrome-relay" },
    });
  }

  chromeRelayWindow.on("closed", () => {
    chromeRelayWindow = null;
  });

  return chromeRelayWindow;
}

export function focusOrCreateChromeRelayWindow(): BrowserWindow {
  if (chromeRelayWindow && !chromeRelayWindow.isDestroyed()) {
    chromeRelayWindow.focus();
    return chromeRelayWindow;
  }

  return createChromeRelayWindow();
}
