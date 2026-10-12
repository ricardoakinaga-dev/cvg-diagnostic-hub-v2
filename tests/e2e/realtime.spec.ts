import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";

test.describe("realtime browser contract", () => {
  test("reconciles an open home after a committed mutation from another page", async ({ page }) => {
    test.setTimeout(60_000);
    await signInAs(page, "vet@cvg.local");
    await expect(page.getByRole("heading", { name: "Solicitações recentes" })).toBeVisible();

    const mutationPage = await page.context().newPage();
    try {
      // The dashboard intentionally keeps an SSE request open; networkidle
      // can therefore never be reached on this page.
      const mutationIdentity = mutationPage.waitForResponse((response) => (
        response.url().endsWith("/api/v1/session/me") && response.request().method() === "GET"
      ));
      await mutationPage.goto("/queues?create=request", { waitUntil: "domcontentloaded" });
      // The shell renders a skeleton until its identity request completes.
      expect((await mutationIdentity).status()).toBe(200);

      const refreshedDashboard = page.waitForResponse((response) => (
        new URL(response.url()).pathname === "/api/v1/diagnostic-requests" &&
        new URL(response.url()).searchParams.get("limit") === "50" &&
        response.request().method() === "GET" &&
        response.status() === 200
      ));
      const initialMutation = mutationPage.waitForResponse((response) => (
        response.url().endsWith("/api/v1/diagnostic-requests") &&
        response.request().method() === "POST"
      ));

      const dialog = mutationPage.getByRole("dialog", { name: "Solicitar exames" });
      await dialog.getByRole("combobox", { name: "Paciente", exact: true }).selectOption("patient-thor");
      await dialog.getByLabel("Atendimento").selectOption("encounter-thor");
      await dialog.getByText("Hemograma", { exact: true }).click();
      await dialog.getByRole("button", { name: /Confirmar solicitação/ }).click();

      let committedResponse = await initialMutation;
      if (committedResponse.status() === 409) {
        expect((await committedResponse.json()).error.code).toBe("DUPLICATE_WARNING");
        await mutationPage.getByLabel("Motivo para prosseguir com a duplicidade").fill("Repetição sintética para provar a reconciliação realtime da tela aberta.");
        const confirmed = mutationPage.waitForResponse((response) => (
          new URL(response.url()).pathname === "/api/v1/diagnostic-requests" && response.request().method() === "POST"
        ));
        await mutationPage.getByRole("button", { name: /Confirmar duplicidade/ }).click();
        committedResponse = await confirmed;
      }

      expect(committedResponse.status()).toBe(201);
      const committedBody = await committedResponse.json() as { data?: { requestCode?: string; items: { id: string; departmentCode: string }[] } };
      const requestCode = committedBody.data?.requestCode;
      expect(requestCode).toMatch(/^EX-/);

      await refreshedDashboard;
      const item = committedBody.data!.items[0];
      const examination = page.locator(`a[href="/queues?dept=${item.departmentCode}&item=${encodeURIComponent(item.id)}"]`);
      await expect(examination).toBeVisible({ timeout: 15_000 });
      await expect(examination).toContainText("Thor — Hemograma");
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await mutationPage.close();
    }
  });
});
