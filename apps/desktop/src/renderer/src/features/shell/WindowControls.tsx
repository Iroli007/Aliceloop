import { getDesktopBridge } from "../../platform/desktopBridge";

type WindowControlsProps = {
  onClose?: () => void;
  sidebarToggle?: {
    label: string;
    onClick: () => void;
  };
  showThreadSearch?: boolean;
};

export function WindowControls({ onClose, sidebarToggle, showThreadSearch = false }: WindowControlsProps) {
  const desktopBridge = getDesktopBridge();

  async function handleCloseWindow() {
    if (onClose) {
      onClose();
      return;
    }

    try {
      await desktopBridge.closeWindow();
    } catch {
      window.close();
    }
  }

  async function handleMinimizeWindow() {
    try {
      await desktopBridge.minimizeWindow();
    } catch {
      // Browser preview falls back to a no-op here.
    }
  }

  async function handleToggleFullscreenWindow() {
    try {
      await desktopBridge.toggleFullscreenWindow();
    } catch {
      // Browser preview falls back to the bridge implementation.
    }
  }

  return (
    <div className="window-controls" role="toolbar" aria-label="窗口控制">
      <div className="window-controls__traffic-group">
        <button
          className="window-controls__traffic-button"
          type="button"
          aria-label={onClose ? "关闭面板" : "关闭窗口"}
          title={onClose ? "关闭面板" : "关闭窗口"}
          onClick={() => void handleCloseWindow()}
        >
          <span className="window-controls__traffic-dot window-controls__traffic-dot--close" />
        </button>
        <button
          className="window-controls__traffic-button"
          type="button"
          aria-label="最小化窗口"
          title="最小化窗口"
          onClick={() => void handleMinimizeWindow()}
        >
          <span className="window-controls__traffic-dot window-controls__traffic-dot--minimize" />
        </button>
        <button
          className="window-controls__traffic-button"
          type="button"
          aria-label="切换全屏"
          title="切换全屏"
          onClick={() => void handleToggleFullscreenWindow()}
        >
          <span className="window-controls__traffic-dot window-controls__traffic-dot--fullscreen" />
        </button>
      </div>

      {sidebarToggle || showThreadSearch ? (
        <div className="window-controls__icon-group">
          {sidebarToggle ? (
            <button
              className="window-controls__icon-button"
              type="button"
              aria-label={sidebarToggle.label}
              title={sidebarToggle.label}
              onClick={sidebarToggle.onClick}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="4.5" />
                <path d="M8.25 7.5V16.5" />
              </svg>
            </button>
          ) : null}

          {showThreadSearch ? (
            <button
              className="window-controls__icon-button"
              type="button"
              aria-label="线程搜索"
              title="线程搜索"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.2 18.2c4.42 0 8-3.13 8-6.98s-3.58-6.97-8-6.97s-8 3.12-8 6.97c0 1.92.89 3.66 2.34 4.92l-.73 3.3l3.27-1.44c.96.14 1.69.2 3.12.2Z" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
