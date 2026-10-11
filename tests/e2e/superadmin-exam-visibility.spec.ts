import { expect, test, type Page } from "@playwright/test";
import { signInAs } from "./support/auth";

async function requestRoutineHemogram(page: Page) {
  await page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await dialog.getByLabel("Paciente", { exact: true }).selectOption("patient-thor");
  await expect(dialog.getByLabel("Atendimento", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Atendimento", { exact: true }).selectOption("encounter-thor");
  await dialog.getByRole("checkbox", { name: /Hemograma/ }).check();
  await dialog.getByRole("button", { name: "Rotina", exact: true }).click();
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar solicitação", exact: true }).click();
  return response;
}

test("superadmin sees a newly registered routine examination in My work after refresh and a duplicate is still rejected", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAs(page, "superadmin@cvg.local");
  await page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ }).click();
  await expect(page).toHaveURL(/\/queues\?view=mine$/);

  const created = await requestRoutineHemogram(page);
  expect(created.status()).toBe(201);
  const request = (await created.json()).data;
  expect(request.items[0]).toMatchObject({ status: "REQUESTED", priority: "ROUTINE" });
  expect(Date.parse(request.items[0].dueAt)).toBeGreaterThan(Date.now());
  await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toHaveCount(0);
  const examination = page.getByRole("button", { name: "Abrir Hemograma — Thor", exact: true });
  await expect(examination).toBeVisible();
  await page.reload();
  await expect(examination).toBeVisible();

  await page.goto("/");
  const myWork = page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ });
  await expect(myWork.locator("strong")).toHaveText("1");
  await myWork.click();
  await expect(examination).toBeVisible();

  const duplicate = await requestRoutineHemogram(page);
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe("DUPLICATE_WARNING");
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(dialog.getByText(/Já existe um exame ativo compatível/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(examination).toBeVisible();
  const persisted = await page.request.get("/api/v1/diagnostic-requests");
  expect(persisted.status()).toBe(200);
  expect((await persisted.json()).data.map((entry: { id: string }) => entry.id)).toEqual([request.id]);
  expect(errors).toEqual([]);
});
