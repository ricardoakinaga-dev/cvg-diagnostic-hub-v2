import { expect, test, type Page } from "@playwright/test";
import { signInAs, signOut } from "./support/auth";

async function requestHemogram(page: Page, patientId: string, encounterId: string) {
  await page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await dialog.getByLabel("Paciente", { exact: true }).selectOption(patientId);
  await expect(dialog.getByLabel("Atendimento", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Atendimento", { exact: true }).selectOption(encounterId);
  await dialog.getByRole("checkbox", { name: /Hemograma/ }).check();
  await dialog.getByRole("button", { name: "Rotina", exact: true }).click();
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/v1/diagnostic-requests" && result.request().method() === "POST");
  await dialog.getByRole("button", { name: "Confirmar solicitação", exact: true }).click();
  return response;
}

async function expectAuthorizedWork(page: Page, count: number) {
  const requests = await page.request.get("/api/v1/diagnostic-requests");
  expect(requests.status()).toBe(200);
  const data = (await requests.json()).data as Array<{ items: Array<{ service: { name: string } }>; patient: { displayName: string } }>;
  expect(data.flatMap((request) => request.items)).toHaveLength(count);
  await page.goto("/");
  const shortcut = page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ });
  await expect(shortcut.locator("strong")).toHaveText(String(count));
  await shortcut.click();
  await expect(page).toHaveURL(/\/queues\?view=mine$/);
  const examinations = page.locator(".work-items").getByRole("button", { name: /^Abrir / });
  await expect(examinations).toHaveCount(count);
  for (const request of data) {
    for (const item of request.items) {
      await expect(page.getByRole("button", { name: `Abrir ${item.service.name} — ${request.patient.displayName}`, exact: true })).toBeVisible();
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
      headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: ["service-hemogram", "service-crp", "service-xray", "service-ultrasound"].map((serviceId) => ({ serviceId })) })
    });
    return { status: response.status, payload: await response.json() };
  }, `shared-care-${testInfo.project.name}-${Date.now()}`);
  expect(created.status).toBe(201);
  expect(created.payload.data.items).toHaveLength(4);
  await signOut(page);

  await signInAs(page, "vet@cvg.local");
  await expectAuthorizedWork(page, 4);
  const own = await requestHemogram(page, "patient-mel", "encounter-mel");
  expect(own.status()).toBe(201);
  await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Abrir Hemograma — Mel", exact: true })).toBeVisible();
  await expectAuthorizedWork(page, 5);

  const duplicate = await requestHemogram(page, "patient-thor", "encounter-thor");
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe("DUPLICATE_WARNING");
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(dialog.getByText(/Já existe um exame ativo compatível/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expectAuthorizedWork(page, 5);
  await signOut(page);

  for (const [email, count, canCreate] of [
    ["lab@cvg.local", 3, false],
    ["rx@cvg.local", 1, false],
    ["us@cvg.local", 1, false],
    ["manager@cvg.local", 5, true],
    ["superadmin@cvg.local", 5, true]
  ] as const) {
    await signInAs(page, email);
    await expectAuthorizedWork(page, count);
    await expect(page.locator(".work-items .page-header").getByRole("button", { name: "Nova solicitação", exact: true })).toHaveCount(canCreate ? 1 : 0);
    await signOut(page);
  }

  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  const denied = await page.request.get("/api/v1/diagnostic-requests");
  expect(denied.status()).toBe(404);
  await expect(page.getByRole("navigation", { name: "Atalhos" }).getByRole("link", { name: /Na minha fila/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
