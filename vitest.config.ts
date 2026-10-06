import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 主题原始文本用于验证终端与界面配色一致，其他样式无需参与 node 测试。
    css: { include: /themes\.css/ },
  },
});
