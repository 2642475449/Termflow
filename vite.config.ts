import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    fileViewerRenderers({
      formats: [
        "doc", "docx", "dot", "dotx", "rtf", "odt",
        "xls", "xlsx", "xlsm", "xlsb", "ods", "csv",
        "ppt", "pptx", "ppsx", "odp",
      ],
      copyAssets: true,
      chunkStrategy: "renderer",
      inject: false,
    }),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: /^antd$/, replacement: path.resolve(__dirname, "./src/lib/antd.ts") },
    ],
  },
  clearScreen: false,
  build: {
    // Monaco bundles its complete offline editor and language-service runtime in one chunk.
    // Keep a guardrail for regressions without warning on that intentional 3.8 MB chunk.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Rollup's default `.[ext]` suffix leaves a trailing dot for extensionless
        // assets such as third-party LICENSE files. Windows cannot embed such a
        // path during the Tauri build, so use extname (including its own dot).
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
