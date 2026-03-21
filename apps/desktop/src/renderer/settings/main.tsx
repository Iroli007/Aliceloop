import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/app.css";

function SettingsApp() {
  return (
    <div style={{ height: "100%", WebkitAppRegion: "drag" } as React.CSSProperties}>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
