import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/styles/app.css";
import { ChromeRelayPanel } from "../src/features/chrome-relay/ChromeRelayPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChromeRelayPanel />
  </StrictMode>,
);
