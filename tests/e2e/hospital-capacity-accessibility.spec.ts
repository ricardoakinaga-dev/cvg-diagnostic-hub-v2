import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { HospitalCapacityView, HospitalTaskView } from "@cvg/contracts";
import { signInAs } from "./support/auth";

async function command<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.post(`/api/v1${path}`, { headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": `capacity-a11y-${Date.now()}-${Math.random()}` }, data });
  expect(response.ok(), `POST ${path}: ${response.status()}`).toBe(true);
  return (await response.json()).data as T;
}

test("hospital capacity excludes private drafts and retains accessible period and workload controls", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local");
  const capacityResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-capacity" && response.request().method() === "GET");
  await page.goto("/planner/capacity", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Capacidade e prazos", exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  const initialResponse = await capacityResponse; expect(initialResponse.ok()).toBe(true);
  const initial = (await initialResponse.json()).data as HospitalCapacityView;
  const load = page.getByRole("region", { name: "Carga autorizada", exact: true });
  await expect(load.getByText(`${initial.authorizedLoad.openHospitalTasks} atividades hospitalares ativas.`, { exact: false })).toBeVisible();
  const draft = await command<HospitalTaskView>(page, "/hospital-task-drafts", { title: `Rascunho de capacidade ${testInfo.project.name}-${Date.now()}`, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "ROUTINE" });
  expect(draft.task.isDraft).toBe(true);
  const sameRange = async () => {
    const response = await page.request.get(initialResponse.url()); expect(response.ok()).toBe(true);
    return (await response.json()).data as HospitalCapacityView;
  };
  expect((await sameRange()).authorizedLoad.openHospitalTasks).toBe(initial.authorizedLoad.openHospitalTasks);
  const published = await command<HospitalTaskView>(page, `/hospital-task-drafts/${draft.task.id}/commands`, { command: "PUBLISH", expectedVersion: draft.task.version });
  expect(published.task.isDraft).toBe(false);
  expect((await sameRange()).authorizedLoad.openHospitalTasks).toBe(initial.authorizedLoad.openHospitalTasks + 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(load.getByText(`${initial.authorizedLoad.openHospitalTasks + 1} atividades hospitalares ativas.`, { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Capacidade dos recursos autorizados", exact: true })).toBeVisible();
  const form = page.getByRole("form", { name: "Filtrar capacidade", exact: true });
  await form.getByLabel("Período de", { exact: true }).focus();
  await expect(form.getByLabel("Período de", { exact: true })).toBeFocused();
  await expect(form.getByLabel("Período até", { exact: true })).toHaveAttribute("type", "datetime-local");
  await expect(form.getByRole("combobox", { name: "Setor da capacidade", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Aplicar período", exact: true })).toBeEnabled();
  const rules = ["aria-allowed-attr", "aria-command-name", "aria-prohibited-attr", "aria-required-attr", "aria-required-children", "aria-required-parent", "aria-roles", "aria-valid-attr", "aria-valid-attr-value", "button-name", "color-contrast", "document-title", "duplicate-id-aria", "html-has-lang", "heading-order", "label", "landmark-one-main", "landmark-unique", "link-name", "nested-interactive", "region", "role-img-alt", "tabindex"];
  const results = await new AxeBuilder({ page }).include("body").withRules(rules).setLegacyMode(true).analyze();
  expect(results.violations, results.violations.map(violation => `${violation.id}: ${violation.help}`).join("; ")).toEqual([]);
});
