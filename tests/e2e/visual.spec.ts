import { expect, test } from "@playwright/test";
import { GREETING, signInAs } from "./support/auth";

test.describe("visual baseline", () => {
  test("dashboard remains stable across the configured viewports", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-01T13:00:00.000Z"));
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const meta = { correlationId: "visual-correlation", requestId: "visual-request" };
      const respond = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data, meta }) });

      if (url.pathname === "/api/v1/diagnostic-requests") return respond([]);
      if (url.pathname === "/api/v1/notifications") return respond([]);
      if (url.pathname === "/api/v1/diagnostic-services") return respond([]);
      if (url.pathname === "/api/v1/dashboard") {
        const timestamp = "2026-10-01T13:00:00.000Z";
        return respond({
          overdue: 0,
          recollections: 0,
          newResults: 0,
          critical: 0,
          totalActive: 0,
          updatedAt: timestamp,
          window: { kind: "CURRENT_STATE", label: "Estado atual", timezone: "America/Sao_Paulo", asOf: timestamp },
          indicators: [],
          attention: [],
          departments: [{ departmentCode: "INPATIENT", label: "INPATIENT", activeItems: 0, overdue: 0, attention: 0, state: "CLEAR" }],
          dataQuality: { status: "FRESH", asOf: timestamp }
        });
      }
      return route.continue();
    });

    await signInAs(page, "vet@cvg.local");
    await expect(page.getByRole("heading", { name: GREETING })).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
      scale: "css"
    });
  });
});
