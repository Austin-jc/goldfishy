import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, DEFAULT_THEME } from "./themes";
import "./index.css";

// Apply the saved theme before first paint to avoid a flash of the default.
applyTheme(localStorage.getItem("nn.theme") ?? DEFAULT_THEME);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
