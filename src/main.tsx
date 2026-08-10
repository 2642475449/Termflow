import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles/global.css";
import { useAppStore, type ThemeCategory, type ThemeMode } from "./store";

declare global {
  interface Window {
    __TERMFLOW_STARTUP_THEME__?: {
      lightTheme: ThemeMode;
      darkTheme: ThemeMode;
      themeCategory: ThemeCategory;
      systemPrefersDark: boolean;
    };
  }
}

const startupTheme = window.__TERMFLOW_STARTUP_THEME__;
if (startupTheme) {
  useAppStore.setState(startupTheme);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
