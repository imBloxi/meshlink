import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { flashFirmware } from "./lib/flasher";
import { requestPortByName } from "./lib/links";
import { useApp } from "./lib/store";
import "./styles.css";

// Automated hardware tests only (app started with --test-hooks).
if (new URLSearchParams(location.search).get("testHooks") === "1") {
  Object.assign(window, { __ml: { useApp, flashFirmware, requestPortByName } });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
