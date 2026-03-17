import type { ShellOverview } from "@aliceloop/runtime-core";
import { dockNav, primaryNav } from "./nav";

type ShellState =
  | {
      status: "loading";
      data: ShellOverview;
      runtimeStatus: string;
    }
  | {
      status: "ready";
      data: ShellOverview;
      runtimeStatus: string;
      source: "daemon" | "preview";
    }
  | {
      status: "error";
      data: ShellOverview;
      runtimeStatus: string;
      error: string;
    };

interface ShellLayoutProps {
  state: ShellState;
}

export function ShellLayout({ state }: ShellLayoutProps) {
  const { data } = state;

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        <header className="sidebar__header">
          <div className="traffic-lights">
            <span className="traffic-lights__dot traffic-lights__dot--red" />
            <span className="traffic-lights__dot traffic-lights__dot--yellow" />
            <span className="traffic-lights__dot traffic-lights__dot--green" />
          </div>
          <div className="sidebar__icons">
            <span>▣</span>
            <span>⌕</span>
            <span>✎</span>
          </div>
        </header>

        <section className="sidebar__threads">
          <button className="sidebar__new-chat">New Chat</button>
        </section>

        <section className="sidebar__panel">
          {primaryNav.map((item) => (
            <button
              key={item.id}
              className="panel-link"
            >
              <span className="panel-link__label">{item.label}</span>
              <span className="panel-link__short">{item.shortLabel}</span>
            </button>
          ))}
        </section>

        <footer className="sidebar__footer">
          <span className="sidebar__runtime">{state.runtimeStatus}</span>
        </footer>
      </aside>

      <main className="shell__main">
        <header className="main__header">
          <div>
            <div className="eyebrow">Aliceloop</div>
            <h1>本地学习 companion 壳</h1>
          </div>
          <div className="header__meta">
            <span>{data.taskRuns.length} 条任务</span>
            <span>{data.library.length} 本资料</span>
          </div>
        </header>

        <section className="hero-grid">
          <article className="hero-card hero-card--wide">
            <div className="hero-card__eyebrow">Current Attention</div>
            <h2>{data.attention.focusSummary}</h2>
            <p>
              正在关注：
              {" "}
              <strong>{data.attention.currentLibraryTitle ?? "未绑定"}</strong>
              {" · "}
              {data.attention.currentSectionLabel ?? "待定位章节"}
            </p>
            <div className="tag-row">
              {data.attention.concepts.map((concept) => (
                <span
                  key={concept}
                  className="tag"
                >
                  {concept}
                </span>
              ))}
            </div>
          </article>

          <article className="hero-card">
            <div className="hero-card__eyebrow">Runtime</div>
            <h2>{state.status === "ready" ? "Daemon Connected" : "Preview Mode"}</h2>
            <p>
              前端只保持结构化壳，后续可用更强模型重做视图，不需要重拆业务接口。
            </p>
          </article>
        </section>

        <section className="content-grid">
          <article className="surface-card">
            <header className="surface-card__header">
              <h3>Library</h3>
              <span>{data.library.length} 本</span>
            </header>
            <div className="surface-list">
              {data.library.map((item) => (
                <div
                  key={item.id}
                  className="surface-list__item"
                >
                  <div>
                    <div className="surface-list__title">{item.title}</div>
                    <div className="surface-list__meta">
                      {item.sourceKind}
                      {" · "}
                      {item.documentKind}
                    </div>
                  </div>
                  <div className="surface-list__badge">{item.lastAttentionLabel ?? "待关注"}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="surface-card">
            <header className="surface-card__header">
              <h3>Artifacts</h3>
              <span>{data.artifacts.length} 个</span>
            </header>
            <div className="surface-list">
              {data.artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="surface-list__item"
                >
                  <div>
                    <div className="surface-list__title">{artifact.title}</div>
                    <div className="surface-list__meta">
                      {artifact.kind}
                      {" · "}
                      {artifact.relatedLibraryTitle}
                    </div>
                  </div>
                  <div className="surface-list__badge">{artifact.updatedAtLabel}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="surface-card">
            <header className="surface-card__header">
              <h3>Long Memory</h3>
              <span>{data.memories.length} 条</span>
            </header>
            <div className="surface-list">
              {data.memories.map((memory) => (
                <div
                  key={memory.id}
                  className="surface-list__item"
                >
                  <div>
                    <div className="surface-list__title">{memory.title}</div>
                    <div className="surface-list__meta">{memory.kind}</div>
                  </div>
                  <div className="surface-list__excerpt">{memory.content}</div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="composer">
          <div className="composer__placeholder">
            输入消息、上传 PDF、或者从 Tele 发来任务。这里先保持壳层可替换，不把 UI 逻辑写死。
          </div>
        </section>

        {state.status === "error" ? (
          <div className="status-banner">
            Daemon 未连接，当前使用预览数据。
            {" "}
            {state.error}
          </div>
        ) : null}
      </main>

      <aside className="shell__dock">
        <div className="dock">
          {dockNav.map((item) => (
            <button
              key={item.id}
              className="dock__button"
              title={item.label}
            >
              {item.shortLabel}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

