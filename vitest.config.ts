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
    // Keep the broad G4 aggregate deterministic across local and CI runs.
    // Some suites mutate process-wide fakes and coverage is merged per file;
    // serial execution prevents scheduling from changing the denominator.
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
      hooks: "list",
      setupFiles: "list",
      shuffle: false
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "json-summary"],
      // G4 measures executable product behavior across app, domain, runtime,
      // persistence and UI. Only type-only seams and test infrastructure are
      // excluded; generated/test files are not part of the product surface.
      include: ["src/**/*.ts", "src/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx"],
      exclude: [
        "src/**/*.d.ts",
        "src/test/**",
        "**/*.test.*",
        "src/server/application/service-context.ts",
        "src/server/application/service-types.ts",
        "src/server/storage/file-store-contract.ts",
        "src/server/store/relational/clinical-core-contracts.ts"
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 }
    }
  }
});
