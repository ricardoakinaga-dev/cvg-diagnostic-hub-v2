import { expect, type Browser, type TestInfo } from "@playwright/test";

/**
 * Gives a scenario its own active HEMOGRAM request for Thor, created by the veterinarian through the API, so the
 * scenario does not depend on data left by other specs (the demo state starts without requests).
 */
export async function seedHemogramRequest(browser: Browser, testInfo: TestInfo, key: string): Promise<void> {
  const vet = await browser.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders });
  try {
    expect((await vet.request.post("/api/v1/session/login", { data: { email: "vet@cvg.local", password: "e2e-local-password-2026" } })).status()).toBe(200);
    const csrf = (await vet.cookies()).find((cookie) => cookie.name === "cvg_csrf")!.value;
    const created = await vet.request.post("/api/v1/diagnostic-requests", {
      headers: { "x-csrf-token": csrf, "idempotency-key": `${key}-${testInfo.project.name}-${Date.now()}` },
      data: { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }
    });
    // 409 means an earlier spec already left an active HEMOGRAM request for this patient, so the data exists.
    expect([201, 409]).toContain(created.status());
  } finally {
    await vet.close();
  }
}
