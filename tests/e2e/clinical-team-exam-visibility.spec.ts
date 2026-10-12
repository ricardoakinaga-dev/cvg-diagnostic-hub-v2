import { expect, test, type Page } from "@playwright/test";
import { TERMINAL_ITEM_STATES, type ItemState } from "@cvg/contracts";
import { signInAs, signOut } from "./support/auth";
import { browserGet } from "./support/browser-request";
const terminalStates = new Set<ItemState>(TERMINAL_ITEM_STATES);

async function requestHemogram(page: Page, patientId: string, encounterId: string, confirmSyntheticDuplicate = false) {
  await page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await dialog.getByLabel("Paciente", { exact: true }).selectOption(patientId);
  await expect(dialog.getByLabel("Atendimento", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Atendimento", { exact: true }).selectOption(encounterId);
  await dialog.getByRole("checkbox", { name: /Hemograma/ }).check();
  await dialog.getByRole("button", { name: "Rotina", exact: true }).click();
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar solicitação", exact: true }).click();
  const first = await response;
  if (!confirmSyntheticDuplicate || first.status() !== 409) return first;
  expect((await first.json()).error.code).toBe("DUPLICATE_WARNING");
  await dialog.getByLabel("Motivo para prosseguir com a duplicidade").fill("Repetição autorizada exclusivamente para esta jornada sintética de visibilidade.");
  const confirmed = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar duplicidade", exact: true }).click();
  return confirmed;
}

interface VisibleRequest { id: string; requestCode: string; items: Array<{ id: string; status: ItemState; service: { name: string } }>; patient: { displayName: string } }
interface CreatedRequest { id: string; requestCode: string; items: Array<{ id: string; workflowType: string }> }

async function expectAuthorizedWork(page: Page, scenarioRequestIds: readonly string[], expectedItemIds: readonly string[]) {
  const requests = await browserGet(page, "/api/v1/diagnostic-requests?limit=100");
  expect(requests.status()).toBe(200);
  const body = await requests.json();
  expect(body.meta.nextCursor).toBeUndefined();
  const data = body.data as VisibleRequest[];
  const scenario = data.filter((request) => scenarioRequestIds.includes(request.id));
  expect(scenario.flatMap((request) => request.items.map((item) => item.id)).sort()).toEqual([...expectedItemIds].sort());
  const count = data.flatMap((request) => request.items).filter((item) => !terminalStates.has(item.status)).length;
  await page.goto("/");
  const shortcut = page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ });
  await expect(shortcut.locator("strong")).toHaveText(String(count));
  await shortcut.click();
  await expect(page).toHaveURL(/\/queues\?view=mine$/);
  const examinations = page.locator(".work-items").getByRole("button", { name: /^Abrir / });
  await expect(examinations).toHaveCount(count);
  for (const request of scenario) {
    for (const item of request.items) {
      const row = page.locator(`[data-item-row][data-request-code="${request.requestCode}"]`).filter({ has: page.getByRole("button", { name: `Abrir ${item.service.name} — ${request.patient.displayName}`, exact: true }) });
      await expect(row).toBeVisible();
    }
  }
  await page.reload();
  await expect(examinations).toHaveCount(count);
}

test("normal clinicians see shared and newly created exams, while each operational profile sees its authorized queue", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAs(page, "superadmin@cvg.local");
  const created = await page.evaluate(async (idempotencyKey) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length) ?? "");
    const response = await fetch("/api/v1/diagnostic-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": idempotencyKey, "x-duplicate-override": "true" },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", overrideReason: "Repetição autorizada exclusivamente para esta jornada sintética de visibilidade compartilhada.", items: ["service-hemogram", "service-crp", "service-xray", "service-ultrasound"].map((serviceId) => ({ serviceId })) })
    });
    return { status: response.status, payload: await response.json() };
  }, `shared-care-${testInfo.project.name}-${Date.now()}`);
  expect(created.status).toBe(201);
  expect(created.payload.data.items).toHaveLength(4);
  const shared = created.payload.data as CreatedRequest;
  const sharedIds = shared.items.map((item) => item.id);
  await signOut(page);

  await signInAs(page, "vet@cvg.local");
  await expectAuthorizedWork(page, [shared.id], sharedIds);
  const own = await requestHemogram(page, "patient-mel", "encounter-mel", true);
  expect(own.status()).toBe(201);
  const ownRequest = (await own.json()).data as CreatedRequest;
  const scenarioIds = [shared.id, ownRequest.id];
  const allIds = [...sharedIds, ...ownRequest.items.map((item) => item.id)];
  await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toHaveCount(0);
  await expect(page.locator(`[data-item-row][data-request-code="${ownRequest.requestCode}"]`).getByRole("button", { name: "Abrir Hemograma — Mel", exact: true })).toBeVisible();
  await expectAuthorizedWork(page, scenarioIds, allIds);

  const duplicate = await requestHemogram(page, "patient-thor", "encounter-thor");
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe("DUPLICATE_WARNING");
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(dialog.getByText(/Já existe um exame ativo compatível/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expectAuthorizedWork(page, scenarioIds, allIds);
  await signOut(page);

  for (const [email, allowedIds, canCreate] of [
    ["lab@cvg.local", [...shared.items.filter((item) => item.workflowType === "LABORATORY").map((item) => item.id), ...ownRequest.items.map((item) => item.id)], false],
    ["rx@cvg.local", shared.items.filter((item) => item.workflowType === "RADIOLOGY").map((item) => item.id), false],
    ["us@cvg.local", shared.items.filter((item) => item.workflowType === "ULTRASOUND").map((item) => item.id), false],
    ["manager@cvg.local", allIds, true],
    ["superadmin@cvg.local", allIds, true]
  ] as const) {
    await signInAs(page, email);
    await expectAuthorizedWork(page, scenarioIds, allowedIds);
    await expect(page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true })).toHaveCount(canCreate ? 1 : 0);
    await signOut(page);
  }

  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  const denied = await browserGet(page, "/api/v1/diagnostic-requests");
  expect(denied.status()).toBe(404);
  await expect(page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
