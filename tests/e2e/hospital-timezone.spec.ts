import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";

test("hospital civil date and greeting agree across distinct browser timezones at midnight UTC", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const timezoneId of ["Asia/Tokyo", "UTC", "America/Sao_Paulo"]) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage(); await page.clock.setFixedTime(new Date("2026-10-11T00:30:00.000Z"));
      await signInAs(page, "vet@cvg.local", /^Boa noite, Marina$/);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(timezoneId);
      await expect(page.locator(".home-greeting")).toContainText("sábado, 10 de outubro");
      await expect(page.getByRole("heading", { level: 1, name: "Boa noite, Marina", exact: true })).toBeVisible();
    } finally { await context.close(); }
  }
});
