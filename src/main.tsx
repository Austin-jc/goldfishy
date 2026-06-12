import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { applyLineNumbers, applyTheme, DEFAULT_THEME } from "./themes";
import "./index.css";

// Both windows route from one bundle, split per window: the pre-created
// capture webview must not parse the editor-sized app chunk just to show
// a textarea (and vice versa, the main window skips the capture chunk).
const App = lazy(() => import("./App"));
const CaptureWindow = lazy(() => import("./components/CaptureWindow"));

// Apply saved display prefs before first paint to avoid a flash of defaults.
applyTheme(localStorage.getItem("nn.theme") ?? DEFAULT_THEME);
applyLineNumbers(localStorage.getItem("nn.lineNumbers") === "1");

// The quick-capture window shares the bundle; route by window label.
const isCapture = getCurrentWebviewWindow().label === "capture";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {isCapture ? <CaptureWindow /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
