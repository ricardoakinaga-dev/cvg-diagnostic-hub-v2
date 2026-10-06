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
        response.url().includes("/api/v1/diagnostic-requests?limit=100") &&
        response.request().method() === "GET" &&
        response.status() === 200
      ));
      const committedMutation = mutationPage.waitForResponse((response) => (
        response.url().endsWith("/api/v1/diagnostic-requests") &&
        response.request().method() === "POST" &&
        response.status() === 201
      ));

      const dialog = mutationPage.getByRole("dialog", { name: "Solicitar exames" });
      await dialog.getByRole("combobox", { name: "Paciente", exact: true }).selectOption("patient-thor");
      await dialog.getByLabel("Atendimento").selectOption("encounter-thor");
      await dialog.getByText("Hemograma", { exact: true }).click();
      await dialog.getByRole("button", { name: /Confirmar solicitação/ }).click();

      const duplicateReason = mutationPage.getByLabel("Motivo para prosseguir com a duplicidade");
      try {
        await duplicateReason.waitFor({ state: "visible", timeout: 1_500 });
        await duplicateReason.fill("Repetição sintética para provar a reconciliação realtime da tela aberta.");
        await mutationPage.getByRole("button", { name: /Confirmar duplicidade/ }).click();
      } catch {
        // The isolated fixture may not contain a matching active request.
      }

      const committedResponse = await committedMutation;
      const committedBody = await committedResponse.json() as { data?: { requestCode?: string } };
      const requestCode = committedBody.data?.requestCode;
      expect(requestCode).toMatch(/^EX-/);

      await refreshedDashboard;
      // The home lists exams by their sector key (LAB-0012), built from the protocol.
      const key = `LAB-${requestCode!.split("-").at(-1)}`;
      await expect(page.getByRole("link", { name: new RegExp(`${key}\\s*Thor — Hemograma`) }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await mutationPage.close();
    }
  });
});
