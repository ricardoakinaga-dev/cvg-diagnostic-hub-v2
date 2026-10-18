import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { DiagnosticRequestDetail, HospitalCalendarPage, HospitalCapacityView, HospitalPlannerMetrics, HospitalResource, HospitalSchedule, HospitalTaskView } from "@cvg/contracts";
import { signInAs, signOut } from "./support/auth";
import { browserGet } from "./support/browser-request";
import { hospitalDateTimeInput } from "../../src/lib/hospital-time";

async function inventory(page: Page, data: Record<string, unknown>): Promise<HospitalResource> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.post("/api/v1/hospital-resources", { headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": `metrics-resource-${Date.now()}-${Math.random()}` }, data });
  expect(response.ok(), `Inventory command returned ${response.status()}`).toBe(true);
  return (await response.json()).data as HospitalResource;
}

/** One native browser POST for this scenario; transport failures propagate without a retry. */
async function browserPost(page: Page, path: string, data: Record<string, unknown>, idempotencyKey: string, duplicateOverride = false): Promise<Pick<APIResponse, "ok" | "status" | "json">> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const headers = { "content-type": "application/json", "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": idempotencyKey, ...(duplicateOverride ? { "x-duplicate-override": "true" } : {}) };
  const result = await page.evaluate(async ({ requestedPath, body, requestHeaders }) => {
    const target = new URL(requestedPath, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/v1/")) {
      throw new Error("Browser test commands must target the current origin API.");
    }
    const response = await fetch(target.href, { method: "POST", credentials: "same-origin", cache: "no-store", headers: requestHeaders, body: JSON.stringify(body) });
    const responseBody: unknown = await response.json();
    return { ok: response.ok, status: response.status, body: responseBody };
  }, { requestedPath: path, body: data, requestHeaders: headers });
  return { ok: () => result.ok, status: () => result.status, json: async () => result.body };
}

test("clinical indicators show real capacity with the same selected interval and sector, separate units and an unknown legacy bed", async ({ page }, testInfo) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const room = await inventory(page, { code: `METRIC_ROOM_${suffix}`, name: `Sala sintética ${suffix}`, kind: "ROOM", departmentCode: "INPATIENT", availabilityWindows: [{ startsAt: "2026-10-11T10:00:00.000Z", endsAt: "2026-10-11T12:00:00.000Z" }] });
  const bed = await inventory(page, { code: `METRIC_BED_${suffix}`, name: `Leito sintético ${suffix}`, kind: "BED", departmentCode: "INPATIENT", ward: "Ala sintética", bedLabel: `Leito ${suffix}`, allowedSpecies: ["Canino"], availabilityWindows: [] });
  await signOut(page); await signInAs(page, "vet@cvg.local");
  await page.goto("/planner/metrics", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Indicadores hospitalares", exact: true })).toBeVisible();
  const form = page.getByRole("form", { name: "Filtrar indicadores hospitalares", exact: true });
  await form.getByRole("combobox", { name: "Setor dos indicadores", exact: true }).selectOption("INPATIENT");
  await form.getByLabel("Período de", { exact: true }).fill("2026-10-11T07:00");
  await form.getByLabel("Período até", { exact: true }).fill("2026-10-11T09:00");
  const selected = (response: { url(): string; request(): { method(): string } }, path: string) => {
    const url = new URL(response.url());
    return url.pathname === `/api/v1/${path}` && response.request().method() === "GET" && url.searchParams.get("departmentCode") === "INPATIENT" && url.searchParams.get("from") === "2026-10-11T10:00:00.000Z" && url.searchParams.get("to") === "2026-10-11T12:00:00.000Z";
  };
  const capacityRead = page.waitForResponse(response => selected(response, "hospital-capacity"));
  const metricsRead = page.waitForResponse(response => selected(response, "hospital-metrics"));
  await form.getByRole("button", { name: "Aplicar período dos indicadores", exact: true }).click();
  const [capacityResponse, metricsResponse] = await Promise.all([capacityRead, metricsRead]);
  expect(capacityResponse.ok()).toBe(true); expect(metricsResponse.ok()).toBe(true);
  const capacity = (await capacityResponse.json()).data as HospitalCapacityView;
  const metrics = (await metricsResponse.json()).data as HospitalPlannerMetrics;
  expect({ from: capacity.from, to: capacity.to }).toEqual({ from: metrics.window.from, to: metrics.window.to });
  const authorizedRoom = capacity.resources.find(entry => entry.resourceId === room.id)!;
  expect(authorizedRoom).toMatchObject({ unit: "MINUTES", nominal: 120, reserved: 0, available: 120, availabilityKnown: true });
  const authorizedBed = capacity.resources.find(entry => entry.resourceId === bed.id)!;
  expect(authorizedBed).toMatchObject({ unit: "BEDS", nominal: 1, available: null, availabilityKnown: false, reason: "LEGACY_OCCUPANCY_NOT_LINKED" });
  const table = page.getByRole("table", { name: "Capacidade dos recursos autorizados", exact: true });
  const roomRow = table.getByRole("rowheader", { name: new RegExp(room.name) }).locator("..");
  await expect(roomRow.getByRole("cell", { name: "120 min", exact: true })).toHaveCount(2);
  const bedRow = table.getByRole("rowheader", { name: new RegExp(bed.name) }).locator("..");
  await expect(bedRow.getByRole("cell", { name: "Leitos", exact: true })).toBeVisible();
  await expect(bedRow.getByRole("cell", { name: "Não informada", exact: true })).toBeVisible();
  const load = page.getByRole("region", { name: "Carga autorizada", exact: true });
  await expect(load).toContainText(`${capacity.authorizedLoad.openHospitalTasks} atividades hospitalares ativas.`);
  await expect(load).toContainText(`Estimativa de esforço: ${capacity.authorizedLoad.estimatedMinutes === null ? "Não informada" : `${capacity.authorizedLoad.estimatedMinutes} min`}`);
  await expect(load).toContainText("A agenda de recursos não pausa nem recalcula esse relógio.");
  await expect(page.getByText(/Definição técnica HPL-CAPACITY-1/)).toContainText("aceitação institucional permanece pendente");
  await form.getByLabel("Período de", { exact: true }).focus();
  await expect(form.getByLabel("Período de", { exact: true })).toBeFocused();
  const rules = ["aria-allowed-attr", "aria-command-name", "aria-prohibited-attr", "aria-required-attr", "aria-required-children", "aria-required-parent", "aria-roles", "aria-valid-attr", "aria-valid-attr-value", "button-name", "color-contrast", "document-title", "duplicate-id-aria", "html-has-lang", "heading-order", "label", "landmark-one-main", "landmark-unique", "link-name", "nested-interactive", "region", "role-img-alt", "tabindex"];
  const axe = await new AxeBuilder({ page }).include("body").withRules(rules).setLegacyMode(true).analyze();
  expect(axe.violations, axe.violations.map(entry => `${entry.id}: ${entry.help}`).join("; ")).toEqual([]);
});

test("an unfinished native execution remains visible after its reservation ends, leaves capacity unknown and opens the exact diagnostic reference", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signInAs(page, "manager@cvg.local");
  const suffix = `${testInfo.project.name}_${Date.now()}`;
  const now = Date.now();
  const roomResponse = await browserPost(page, "/api/v1/hospital-resources", { code: `OPEN_ROOM_${suffix}`, name: `Sala em execução ${suffix}`, kind: "ROOM", departmentCode: "INPATIENT", availabilityWindows: [{ startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 86_400_000).toISOString() }] }, `metrics-resource-${Date.now()}-${Math.random()}`);
  expect(roomResponse.ok(), `Inventory command returned ${roomResponse.status()}`).toBe(true);
  const room = (await roomResponse.json()).data as HospitalResource;
  async function command<T>(path: string, data: Record<string, unknown>, expectedStatus: number): Promise<T> {
    const response = await browserPost(page, `/api/v1${path}`, data, `open-execution-${suffix}-${path}`);
    expect(response.status(), `POST ${path}`).toBe(expectedStatus);
    return (await response.json()).data as T;
  }
  const created = await command<HospitalTaskView>("/hospital-tasks", { title: `Execução sem término ${suffix}`, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-manager" }, 201);
  const reservation = await command<HospitalSchedule>(`/hospital-tasks/${created.task.id}/reservations`, { startsAt: new Date(Date.now() - 1_000).toISOString(), endsAt: new Date(Date.now() + 20_000).toISOString(), resourceIds: [room.id], expectedVersion: created.task.version }, 201);
  const running = await command<HospitalTaskView>(`/hospital-tasks/${created.task.id}/commands`, { command: "START", expectedVersion: created.task.version }, 200);
  expect(running.task).toMatchObject({ phase: "IN_PROGRESS", startedBy: "user-manager" });
  expect(running.task.startedAt! >= reservation.startsAt && running.task.startedAt! < reservation.endsAt).toBe(true);
  expect(running.task.completedAt).toBeUndefined();
  // Wait for the native reservation boundary; neither browser nor server clocks are replaced.
  await page.waitForTimeout(Math.max(0, Date.parse(reservation.endsAt) - Date.now() + 100));
  const calendarRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-calendar" && response.request().method() === "GET");
  await page.goto("/planner/agenda", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Agenda hospitalar", exact: true })).toBeVisible();
  const response = await calendarRead; expect(response.status()).toBe(200);
  expect(Date.parse(new URL(response.url()).searchParams.get("from")!)).toBeGreaterThan(Date.parse(reservation.endsAt));
  const calendar = (await response.json()).data as HospitalCalendarPage;
  expect(calendar.items.find(event => event.id === `execution:${created.task.id}`)).toMatchObject({ kind: "EXECUTION", startsAt: running.task.startedAt, deepLink: `/planner/tasks/${created.task.id}` });
  expect(calendar.items.find(event => event.id === `execution:${created.task.id}`)?.endsAt).toBeUndefined();
  await expect(page.getByRole("link", { name: created.task.title, exact: true })).toBeVisible();

  const capacityRead = page.waitForResponse(result => new URL(result.url()).pathname === "/api/v1/hospital-capacity" && result.request().method() === "GET");
  await page.goto("/planner/capacity", { waitUntil: "domcontentloaded" });
  const capacityResponse = await capacityRead; expect(capacityResponse.status()).toBe(200);
  const capacity = (await capacityResponse.json()).data as HospitalCapacityView;
  expect(capacity.from > reservation.endsAt).toBe(true);
  expect(capacity.resources.find(resource => resource.resourceId === room.id)).toMatchObject({ reserved: 0, available: null, availabilityKnown: false, reason: "EXECUTION_END_UNKNOWN" });
  const row = page.getByRole("table", { name: "Capacidade dos recursos autorizados", exact: true }).getByRole("rowheader", { name: new RegExp(room.name) }).locator("..");
  await expect(row).toContainText("término da execução desconhecido");
  await expect(row.getByRole("cell", { name: "Não informada", exact: true })).toBeVisible();
  const current = await browserGet(page, `/api/v1/hospital-tasks/${created.task.id}`); expect(current.status()).toBe(200);
  expect((await current.json()).data.task).toEqual(running.task);

  await signOut(page); await signInAs(page, "vet@cvg.local");
  const requested = await browserPost(page, "/api/v1/diagnostic-requests", { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", overrideReason: "Referência sintética da agenda, sem paciente hospitalar real.", items: [{ serviceId: "service-crp" }] }, `calendar-reference-${suffix}`, true);
  expect(requested.status()).toBe(201); const request = (await requested.json()).data as DiagnosticRequestDetail; const item = request.items[0];
  await page.goto("/planner/agenda", { waitUntil: "domcontentloaded" });
  const form = page.getByRole("form", { name: "Filtros da agenda", exact: true });
  await form.getByLabel("Período de", { exact: true }).fill(hospitalDateTimeInput(new Date(Date.parse(item.dueAt) - 3_600_000).toISOString()));
  await form.getByLabel("Período até", { exact: true }).fill(hospitalDateTimeInput(new Date(Date.parse(item.dueAt) + 3_600_000).toISOString()));
  await form.getByRole("combobox", { name: "Fonte do evento", exact: true }).selectOption("DEADLINE");
  await form.getByRole("button", { name: "Aplicar período", exact: true }).click();
  const link = page.locator(`a[href="/requests/${request.id}#${item.id}"]`);
  await expect(link).toHaveCount(1); await link.click();
  await expect(page).toHaveURL(url => url.pathname === `/requests/${request.id}` && url.hash === `#${item.id}`);
  await expect(page.locator(`article[id="${item.id}"]`).getByRole("heading", { name: item.service.name, exact: true })).toBeVisible();
  await signOut(page); await signInAs(page, "lab@cvg.local");
  const denied = await browserGet(page, `/api/v1/hospital-calendar?from=${encodeURIComponent(capacity.from)}&to=${encodeURIComponent(capacity.to)}&departmentCode=INPATIENT`);
  expect(denied.status()).toBe(404);
  const deniedCapacity = await browserGet(page, `/api/v1/hospital-capacity?from=${encodeURIComponent(capacity.from)}&to=${encodeURIComponent(capacity.to)}&departmentCode=INPATIENT`);
  expect(deniedCapacity.status()).toBe(404);
  await page.goto("/planner/agenda", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Agenda hospitalar", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: created.task.title, exact: true })).toHaveCount(0);
});
