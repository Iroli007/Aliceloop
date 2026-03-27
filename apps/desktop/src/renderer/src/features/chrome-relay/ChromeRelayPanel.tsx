import { useEffect, useMemo, useState } from "react";
import type { ChromeRelayState, DesktopBridge } from "../../platform/desktopBridge";
import { getDesktopBridge } from "../../platform/desktopBridge";
import { WindowControls } from "../shell/WindowControls";

function maskToken(token: string) {
  if (token.length <= 12) {
    return token;
  }

  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return <span className={`chrome-relay__status-dot${healthy ? " chrome-relay__status-dot--healthy" : ""}`} aria-hidden="true" />;
}

async function readChromeRelayState(bridge: DesktopBridge) {
  return await bridge.getChromeRelayState();
}

export function ChromeRelayPanel() {
  const desktopBridge = useMemo(() => getDesktopBridge(), []);
  const [state, setState] = useState<ChromeRelayState | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function syncState() {
      try {
        const nextState = await readChromeRelayState(desktopBridge);
        if (!cancelled) {
          setState(nextState);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    setLoading(true);
    void syncState();
    const timer = window.setInterval(() => {
      void syncState();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [desktopBridge]);

  async function refreshState() {
    setLoading(true);
    try {
      const nextState = await readChromeRelayState(desktopBridge);
      setState(nextState);
      setNotice("状态已刷新。");
    } finally {
      setLoading(false);
    }
  }

  async function copyToken() {
    const token = state?.browserRelay?.token;
    if (!token) {
      return;
    }

    await navigator.clipboard.writeText(token);
    setNotice("Token 已复制。");
  }

  async function regenerateToken() {
    const nextState = await desktopBridge.regenerateChromeRelayToken();
    setState(nextState);
    setNotice("Token 已重置，请把新的 token 同步到扩展。");
  }

  async function launchChrome() {
    const nextState = await desktopBridge.launchChromeRelay();
    setState(nextState);
    setNotice("Chrome 已启动，请等待扩展自动连上。");
  }

  const relay = state?.browserRelay ?? null;
  const connected = Boolean(relay?.enabled && relay.healthy);
  const token = relay?.token ?? "";
  const relayUrl = relay?.baseUrl ?? "http://127.0.0.1:23001";

  return (
    <div className="settings-modal chrome-relay">
      <div className="settings-content">
        <header className="settings-content__header chrome-relay__header">
          <WindowControls />
        </header>

        <div className="settings-content__body">
          <div className="settings-panel__item chrome-relay__card">
            <div className="settings-panel__heading chrome-relay__card-heading">
              <span>配置步骤</span>
            </div>
            <ol className="chrome-relay__steps">
              <li>
                <strong>先启动 Relay</strong>
                <span>点下面的“启动 Chrome”，让本地服务先跑起来。</span>
              </li>
              <li>
                <strong>再启用扩展</strong>
                <span>Chrome Relay 扩展会自动读取端口和 token；如果没连上，就在扩展设置里手动粘贴。</span>
              </li>
              <li>
                <strong>最后确认连接</strong>
                <span>状态变成“已连接”后，后面的浏览器任务就能复用真实登录态了。</span>
              </li>
            </ol>
            <div className="provider-notice">
              如果你已经装好扩展，通常只要启动 Chrome，几秒钟后就会自动连上。
            </div>
          </div>

          <div className="settings-panel__item chrome-relay__card">
            <div className="settings-panel__heading chrome-relay__card-heading">
              <span>连接状态</span>
            </div>
            <div className="chrome-relay__status-grid">
              <span>状态</span>
              <strong className="chrome-relay__status-value">
                <StatusDot healthy={connected} />
                {connected ? "已连接" : "未连接"}
              </strong>
              <span>已连接标签页</span>
              <strong>{loading ? "…" : state?.attachedTabs ?? 0}</strong>
              <span>Relay 地址</span>
              <strong>{relayUrl}</strong>
            </div>
            {notice ? <div className="provider-notice">{notice}</div> : null}
          </div>

          <div className="settings-panel__item chrome-relay__card">
            <div className="settings-panel__heading chrome-relay__card-heading">
              <span>连接令牌</span>
            </div>
            <div className="chrome-relay__token-row">
              <code className="chrome-relay__token-box">{loading ? "…" : maskToken(token)}</code>
              <div className="chrome-relay__token-actions">
                <button className="settings-actions__button" type="button" onClick={() => void copyToken()} disabled={!token}>
                  复制
                </button>
                <button className="settings-actions__button settings-actions__button--primary" type="button" onClick={() => void regenerateToken()}>
                  重置
                </button>
                <button className="settings-actions__button" type="button" onClick={() => void refreshState()}>
                  重新检测
                </button>
              </div>
            </div>
            <div className="provider-notice">
              这个 token 用来让扩展连接桌面 Relay，别随便发给别人。
            </div>
          </div>

          <div className="settings-panel__item chrome-relay__card">
            <div className="settings-panel__heading chrome-relay__card-heading">
              <span>启动 Chrome</span>
            </div>
            <div className="provider-notice">
              用 relay profile 启动 Chrome，扩展会自动接入当前桌面端。
            </div>
            <div className="provider-notice">
              建议先关掉所有 Chrome 窗口，再点一次启动。
            </div>
            <div className="chrome-relay__launch-row">
              <button className="settings-actions__button settings-actions__button--primary" type="button" onClick={() => void launchChrome()}>
                启动 Chrome
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
