import { expect, type Browser, type TestInfo } from "@playwright/test";

/**
 * Gives a scenario its own active HEMOGRAM request for Thor, created by the veterinarian, so the scenario does not
 * depend on data left by other specs (the demo state starts without requests).
 *
 * The calls run inside a page with the browser's fetch, not through Playwright's API client: against the
 * production build (PostgreSQL job) the session cookies are `Secure`, which Chromium honours on 127.0.0.1 but the
 * API client does not send over http.
 */
export async function seedHemogramRequest(browser: Browser, testInfo: TestInfo, key: string): Promise<void> {
  const vet = await browser.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders });
  try {
    const page = await vet.newPage();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const statuses = await page.evaluate(async (idempotencyKey) => {
      const json = { "content-type": "application/json" };
      const login = await fetch("/api/v1/session/login", { method: "POST", headers: json, body: JSON.stringify({ email: "vet@cvg.local", password: "e2e-local-password-2026" }) });
      const csrf = decodeURIComponent(document.cookie.split("; ").find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length) ?? "");
      const created = await fetch("/api/v1/diagnostic-requests", {
        method: "POST",
        headers: { ...json, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
        body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
      });
      return { login: login.status, created: created.status };
    }, `${key}-${testInfo.project.name}-${Date.now()}`);
    expect(statuses.login).toBe(200);
    // 409 means an earlier spec already left an active HEMOGRAM request for this patient, so the data exists.
    expect([201, 409]).toContain(statuses.created);
  } finally {
    await vet.close();
  }
}
