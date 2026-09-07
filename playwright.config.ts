import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChrome = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const e2eLoginRateLimit = 100;
const e2eProxySecret = "e2e-proxy-secret-2026";
const e2eProxyHeaders = (clientAddress: string) => ({
  "x-cvg-proxy-secret": e2eProxySecret,
  "x-forwarded-for": clientAddress
});
const externalBaseUrl = process.env.BASE_URL;
const e2ePortBase = Number(process.env.E2E_PORT_BASE ?? "3100");
if (!Number.isInteger(e2ePortBase) || e2ePortBase < 1024 || e2ePortBase > 65533) {
  throw new Error("E2E_PORT_BASE must be an integer between 1024 and 65533.");
}
const e2eProjectPorts = { chromium: e2ePortBase, tablet: e2ePortBase + 1, mobile: e2ePortBase + 2 } as const;
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === "true";
const e2eCommand = (port: number) => `PORT=${port} NEXT_DIST_DIR=.next-e2e-${port} APP_DATA_MODE=memory RATE_LIMIT_MODE=memory TRUST_PROXY=true TRUST_PROXY_SHARED_SECRET=${e2eProxySecret} OUTBOX_INLINE_LOCAL=true DEMO_PASSWORD=e2e-local-password-2026 CRITICAL_POLICY_ENABLED=true CRITICAL_POLICY_VERSION=e2e-policy-v1 CRITICAL_POLICY_APPROVAL_REF=e2e-approval-2026 CRITICAL_POLICY_APPROVED_AT=2026-08-20T10:00:00.000Z LOGIN_RATE_LIMIT=${e2eLoginRateLimit} STORAGE_SCAN_MODE=local npm run dev`;
const e2eWebServers = externalBaseUrl
  ? {
      // An explicit external target must fail closed instead of silently
      // replacing a missing PostgreSQL runtime with an in-memory server.
      command: reuseExistingServer ? "node -e \"process.exit(1)\"" : e2eCommand(3000),
      url: externalBaseUrl,
      // An explicit opt-in lets the suite validate an already-started target
      // runtime (for example a disposable PostgreSQL-backed server) without
      // weakening the default disposable-server isolation.
      reuseExistingServer,
      timeout: 120_000
    }
  : Object.entries(e2eProjectPorts).map(([name, port]) => ({ name, command: e2eCommand(port), url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 120_000 }));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${e2eProjectPorts.chromium}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // The workspace uses the system Chrome; recording requires a separately managed
    // ffmpeg binary and must not prevent the browser context from starting.
    video: "off",
    ...(systemChrome ? { launchOptions: { executablePath: systemChrome } } : {}),
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: externalBaseUrl ?? `http://localhost:${e2eProjectPorts.chromium}`, extraHTTPHeaders: e2eProxyHeaders("198.51.100.10") } },
    // The shared system Chrome is used in this workspace; emulate the tablet viewport
    // without the touch profile, which exits before launch on the available host.
    { name: "tablet", use: { ...devices["Desktop Chrome"], baseURL: externalBaseUrl ?? `http://localhost:${e2eProjectPorts.tablet}`, viewport: { width: 834, height: 1194 }, extraHTTPHeaders: e2eProxyHeaders("198.51.100.11") } },
    { name: "mobile", use: { ...devices["Pixel 5"], baseURL: externalBaseUrl ?? `http://localhost:${e2eProjectPorts.mobile}`, extraHTTPHeaders: e2eProxyHeaders("198.51.100.12") } }
  ],
  // The E2E servers are disposable and synthetic. Each project gets an isolated
  // memory store so one viewport cannot contaminate another project's state.
  // An explicit BASE_URL keeps the existing single external-server mode.
  webServer: e2eWebServers
});
