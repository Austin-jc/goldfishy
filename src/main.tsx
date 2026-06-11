import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import CaptureWindow from "./components/CaptureWindow";
import { applyLineNumbers, applyTheme, DEFAULT_THEME } from "./themes";
import "./index.css";

// Apply saved display prefs before first paint to avoid a flash of defaults.
applyTheme(localStorage.getItem("nn.theme") ?? DEFAULT_THEME);
applyLineNumbers(localStorage.getItem("nn.lineNumbers") === "1");

// The quick-capture window shares the bundle; route by window label.
const isCapture = getCurrentWebviewWindow().label === "capture";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : <App />}
  </React.StrictMode>,
);
