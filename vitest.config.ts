import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@cvg/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
      "@cvg/domain": path.resolve(__dirname, "packages/domain/src/index.ts"),
      "@cvg/ui": path.resolve(__dirname, "packages/ui/src/index.tsx"),
      "@cvg/services": path.resolve(__dirname, "packages/services/src/index.ts"),
      "@cvg/shared-state": path.resolve(__dirname, "packages/shared-state/src/index.ts")
    }
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "packages/**/*.test.ts", "packages/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "json-summary"],
      include: ["src/server/**/*.ts", "src/components/api-client.ts", "src/components/status-badge.tsx", "packages/domain/src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/test/**",
        "src/app/**",
        "src/server/domain/models.ts",
        "src/server/store/postgres-store.ts",
        "src/server/store/runtime.ts",
        "src/components/app-shell.tsx",
        "src/components/dashboard.tsx",
        "src/components/login-form.tsx",
        "src/components/notifications-view.tsx",
        "src/components/queue-view.tsx",
        "src/components/request-detail.tsx"
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }
    }
  }
});
