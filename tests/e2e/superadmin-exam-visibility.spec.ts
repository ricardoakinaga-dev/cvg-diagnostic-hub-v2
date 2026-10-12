import { expect, test, type Page } from "@playwright/test";
import { TERMINAL_ITEM_STATES, type ItemState } from "@cvg/contracts";
import { signInAs } from "./support/auth";

const terminalStates = new Set<ItemState>(TERMINAL_ITEM_STATES);
interface VisibleRequest { id: string; requestCode: string; items: Array<{ id: string; status: ItemState; priority: string; dueAt: string }> }

async function visibleRequests(page: Page): Promise<VisibleRequest[]> {
  const response = await page.request.get("/api/v1/diagnostic-requests?limit=50");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.meta.nextCursor).toBeUndefined();
  return body.data;
}

async function requestRoutineHemogram(page: Page, confirmSyntheticDuplicate = false) {
  await page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await dialog.getByLabel("Paciente", { exact: true }).selectOption("patient-thor");
  await expect(dialog.getByLabel("Atendimento", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Atendimento", { exact: true }).selectOption("encounter-thor");
  await dialog.getByRole("checkbox", { name: /Hemograma/ }).check();
  await dialog.getByRole("button", { name: "Rotina", exact: true }).click();
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar solicitação", exact: true }).click();
  const first = await response;
  if (!confirmSyntheticDuplicate || first.status() !== 409) return first;
  expect((await first.json()).error.code).toBe("DUPLICATE_WARNING");
  await dialog.getByLabel("Motivo para prosseguir com a duplicidade").fill("Repetição autorizada exclusivamente para esta jornada sintética de visibilidade SUPERADMIN.");
  const confirmed = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar duplicidade", exact: true }).click();
  return confirmed;
}

test("superadmin sees a newly registered routine examination in My work after refresh and a duplicate is still rejected", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAs(page, "superadmin@cvg.local");
  await page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ }).click();
  await expect(page).toHaveURL(/\/queues\?view=mine$/);

  const before = await visibleRequests(page);
  const created = await requestRoutineHemogram(page, true);
  expect(created.status()).toBe(201);
  const request = (await created.json()).data as VisibleRequest;
  expect(request.items[0]).toMatchObject({ status: "REQUESTED", priority: "ROUTINE" });
  expect(Date.parse(request.items[0].dueAt)).toBeGreaterThan(Date.now());
  await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toHaveCount(0);
  const examination = page.locator(`[data-item-row][data-request-code="${request.requestCode}"]`).getByRole("button", { name: "Abrir Hemograma — Thor", exact: true });
  await expect(examination).toBeVisible();
  await page.reload();
  await expect(examination).toBeVisible();

  await page.goto("/");
  const persistedAfterCreate = await visibleRequests(page);
  expect(persistedAfterCreate.map((entry) => entry.id).sort()).toEqual([...before.map((entry) => entry.id), request.id].sort());
  const activeCount = persistedAfterCreate.flatMap((entry) => entry.items).filter((item) => !terminalStates.has(item.status)).length;
  const myWork = page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ });
  await expect(myWork.locator("strong")).toHaveText(String(activeCount));
  await myWork.click();
  await expect(examination).toBeVisible();

  const duplicate = await requestRoutineHemogram(page);
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe("DUPLICATE_WARNING");
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(dialog.getByText(/Já existe um exame ativo compatível/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(examination).toBeVisible();
  const persisted = await visibleRequests(page);
  expect(persisted.map((entry) => entry.id).sort()).toEqual(persistedAfterCreate.map((entry) => entry.id).sort());
  expect(errors).toEqual([]);
});
