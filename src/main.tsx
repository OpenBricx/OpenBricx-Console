import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { installHostSdk } from "./host/install";
import { initTheme } from "./ui/theme";

// Apply the saved light/dark theme before the first paint (no dark flash).
initTheme();

// Publish the plugin host SDK before anything can import a plugin module.
installHostSdk();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
