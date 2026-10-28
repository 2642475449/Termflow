import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";

const host = process.env.TAURI_DEV_HOST;

// 与 Office 插件复制的离线资源共用路径，避免 Vite 再生成一份带哈希的副本。
// 保留 copyAssets：PPT Worker 仍通过相对路径读取这些文件。
const OFFICE_ASSET_PATHS = new Map([
  ["ppt-font-cjk.otf", "vendor/ppt/ppt-font-cjk.otf"],
  ["ppt-native.wasm", "vendor/ppt/ppt-native.wasm"],
  ["pptx.worker.js", "vendor/pptx/pptx.worker.js"],
]);

export default defineConfig(async () => ({
  plugins: [
    {
      name: "termflow-runtime-diagnostics",
      apply: "serve",
      configureServer(server) {
        server.ws.on("termflow:runtime-error", (data: unknown) => {
          if (!data || typeof data !== "object") return;
          const error = data as { message?: unknown; stack?: unknown };
          if (typeof error.message !== "string") return;
          const entry = {
            time: new Date().toISOString(),
            message: error.message.slice(0, 2000),
            stack: typeof error.stack === "string" ? error.stack.slice(0, 12000) : undefined,
          };
          appendFileSync(path.join(tmpdir(), "termflow-dev-runtime-errors.log"), `${JSON.stringify(entry)}\n`);
        });
      },
    },
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
        assetFileNames: (asset) => {
          for (const name of asset.names) {
            const officePath = OFFICE_ASSET_PATHS.get(name);
            if (officePath) return officePath;
          }
          return "assets/[name]-[hash][extname]";
        },
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
      // 本地依赖缓存包含大量文件，无需参与前端热更新监听。
      ignored: ["**/src-tauri/**", "**/.pnpm-store/**", "**/.corepack/**"],
    },
  },
}));
