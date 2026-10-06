import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { ItemState } from "@cvg/contracts";
import { signInAs } from "./support/auth";

async function mockExams(page: Page, count = 1, status: ItemState = "REQUESTED") {
  const current = { status, version: 1 };
  await page.clock.setFixedTime(new Date("2026-10-06T13:00:00Z"));
  await page.route("**/api/v1/diagnostic-requests?*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: [{
      id: "request-audit", requestCode: "EX-261006-1001", requesterId: "user-vet", priority: "ROUTINE", createdAt: "2026-10-06T12:00:00Z",
      patient: { id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
      items: Array.from({ length: count }, (_, index) => ({ id: `item-audit-${index}`, requestId: "request-audit", status: current.status, priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: current.version, currentSampleId: current.status === "RECEIVED" ? "sample-audit" : undefined, dueAt: "2026-10-06T15:00:00Z", service: { id: `service-audit-${index}`, code: `AUDIT_${index}`, name: `Exame audit ${index + 1}` } }))
    }], meta: { correlationId: "plane-audit-correlation", requestId: "plane-audit-request" } })
  }));
  return current;
}

test("a failed older move preserves the newer reconciled examination state", async ({ page }) => {
  const current = await mockExams(page, 1, "RECEIVED");
  await page.route("**/api/v1/queues/*/items?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], meta: { correlationId: "plane-audit-correlation", requestId: "plane-audit-request" } }) }));
  let release!: () => void;
  let commandSeen = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/diagnostic-items/item-audit-0/start-processing", async (route) => {
    commandSeen = true;
    await pending;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "CONFLICT", message: "Conflito sintético" } }) });
  });
  try {
    await signInAs(page, "lab@cvg.local");
    await page.goto("/queues");
    await page.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }).click();
    await page.getByRole("menuitem", { name: "Em execução" }).click();
    await expect.poll(() => commandSeen).toBe(true);
    current.status = "RESULT_AVAILABLE";
    current.version = 2;
    await page.evaluate(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    const newerState = page.getByRole("button", { name: /^Estado: Resultado disponível/ });
    await expect(newerState).toBeVisible();
    release();
    await expect(page.getByText("Não foi possível mover o exame", { exact: true })).toBeVisible();
    await expect(newerState).toBeVisible();
  } finally { release(); }
});

test("failed exam loading never claims that the clinical workload is clear", async ({ page }) => {
  await page.route("**/api/v1/diagnostic-requests?*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Falha sintética" } }) }));
  await signInAs(page, "vet@cvg.local");
  await expect(page.getByRole("heading", { name: "Não foi possível carregar os exames" })).toBeVisible();
  await expect(page.getByText("Nenhum exame exige atenção imediata.")).toHaveCount(0);
  await page.unroute("**/api/v1/diagnostic-requests?*");
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByRole("navigation", { name: "Atalhos" })).toBeVisible();
});

test("opens an authorized request while the examination list is still pending", async ({ page }) => {
  await signInAs(page, "vet@cvg.local");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/diagnostic-requests?*", async (route) => { await pending; await route.continue(); });
  const response = page.waitForResponse((result) => result.url().includes("/api/v1/diagnostic-requests?"));
  try {
    await page.goto("/queues?create=request");
    await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toBeVisible();
    await expect(page.locator(".work-items-canvas")).toHaveAttribute("aria-busy", "true");
  } finally { release(); }
  await response;
  await expect(page.locator(".work-items-canvas")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toBeVisible();
});

test("fullscreen examination context contains focus and restores its opener", async ({ page }, testInfo) => {
  await mockExams(page);
  await signInAs(page, "vet@cvg.local");
  await page.goto("/queues");
  const opener = page.getByRole("button", { name: "Abrir Exame audit 1 — Thor" });
  await opener.click();
  const peek = page.getByRole("dialog", { name: "Exame audit 1" });
  await expect(peek).toBeVisible();
  if (testInfo.project.name !== "chromium") {
    await expect(peek).toHaveAttribute("aria-modal", "true");
    const last = peek.getByRole("link").last();
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(peek.getByRole("button", { name: "Fechar contexto" })).toBeFocused();
    await expect(page.locator(".app-topbar")).toHaveAttribute("inert", "");
  } else {
    await expect(peek).toHaveAttribute("aria-modal", "false");
  }
  await peek.getByRole("button", { name: "Fechar contexto" }).click();
  await expect(peek).toBeHidden();
  await expect(opener).toBeFocused();
});

test("desktop collapse preserves mobile sector links and query navigation closes the drawer", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("cvg.sidebar.collapsed", "1"); localStorage.setItem("cvg.sidebar.sectors", JSON.stringify(["LABORATORY"])); });
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, "vet@cvg.local");
  await page.goto("/queues");
  await page.getByRole("button", { name: "Abrir menu", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Navegação principal" });
  const overdue = navigation.getByRole("link", { name: "Em atraso", exact: true });
  await expect(overdue).toBeVisible();
  await overdue.click();
  await expect(page).toHaveURL(/dept=LABORATORY&preset=overdue/);
  await expect(page.locator(".sidebar")).toBeHidden();
});

test("changing a clinical action inside context keeps the original focus destination", async ({ page }) => {
  await mockExams(page);
  await signInAs(page, "lab@cvg.local");
  await page.goto("/queues");
  const opener = page.getByRole("button", { name: "Abrir Exame audit 1 — Thor" });
  await opener.click();
  const peek = page.getByRole("dialog", { name: "Exame audit 1" });
  await peek.getByRole("button", { name: "Estado: Solicitado. Mudar estado" }).click();
  await peek.getByRole("menuitem", { name: "Amostra recebida" }).click();
  await expect(peek.getByRole("form", { name: "Receber amostra" })).toBeVisible();
  await peek.getByRole("button", { name: "Fechar contexto" }).click();
  await expect(opener).toBeFocused();
});

test("calendar exposes every examination on a busy day with valid grid relationships", async ({ page }) => {
  await mockExams(page, 13);
  await signInAs(page, "vet@cvg.local");
  await page.goto("/queues");
  await page.getByRole("radio", { name: "Calendário" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  const results = await new AxeBuilder({ page }).include(".calendar-grid").withRules(["aria-required-parent", "aria-required-children"]).analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole("button", { name: /\+10 exames/ }).click();
  await expect(page.getByRole("button", { name: "Abrir Exame audit 13 — Thor" })).toBeVisible();
});
