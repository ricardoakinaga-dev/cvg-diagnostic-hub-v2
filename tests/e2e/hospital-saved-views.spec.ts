import { expect, test, type Page } from "@playwright/test";
import type { DiagnosticRequestDetail, HospitalPlanView, SavedPlannerView } from "@cvg/contracts";
import { PLANNER_DEFAULT_DISPLAY } from "../../src/components/planner-model";
import { signInAs } from "./support/auth";
import { browserGet } from "./support/browser-request";

async function write<T>(page: Page, path: string, data: Record<string, unknown>, method: "POST" | "PUT" = "POST"): Promise<T> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.fetch(`/api/v1${path}`, { method, headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": `saved-view-${Date.now()}-${Math.random()}`, ...(path === "/diagnostic-requests" ? { "x-duplicate-override": "true" } : {}) }, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true); return (await response.json()).data as T;
}
async function apply(page: Page, view: SavedPlannerView) {
  await expect(page.getByRole("option", { name: `${view.name} · Compartilhada`, exact: true })).toBeAttached();
  await page.getByRole("combobox", { name: "Aplicar visão salva", exact: true }).selectOption(view.id);
  await expect(page.getByRole("list", { name: "Critérios da visão salva", exact: true })).toContainText("Responsável: user-lab");
}

test("normal clinician reapplies a shared view in one selection on Home, queue and search with identical criteria and reload", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000); await signInAs(page, "vet@cvg.local");
  // API commands prepare synthetic clinical references and a saved configuration. The three surface selections below are real browser interactions.
  const request = await write<DiagnosticRequestDetail>(page, "/diagnostic-requests", { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", overrideReason: "Jornada sintética de filtros, sem atendimento hospitalar real.", items: [{ serviceId: "service-crp" }] });
  expect(request.items).toHaveLength(1); const item = request.items[0];
  const labContext = await browser.newContext();
  try { const lab = await labContext.newPage(); await signInAs(lab, "lab@cvg.local"); await write(lab, `/diagnostic-items/${item.id}/assignment`, { userId: "user-lab", expectedVersion: item.version }, "PUT"); } finally { await labContext.close(); }
  const plan = await write<HospitalPlanView>(page, "/hospital-plans", { title: `Plano de filtro ${testInfo.project.name} ${Date.now()}`, objective: "Conferir referências de uma visão salva sintética.", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "LABORATORY"], steps: [{ id: "step", title: "Referência sintética", sortOrder: 0 }] });
  await write(page, `/hospital-plans/${plan.plan.id}/links`, { stepId: "step", targetType: "DIAGNOSTIC_ITEM", targetId: item.id, active: true, expectedVersion: plan.plan.version }, "PUT");
  const filters = { departmentCode: "LABORATORY", responsibleUserId: "user-lab", priority: "ROUTINE", phase: "PENDING", from: request.createdAt, to: request.createdAt, planId: plan.plan.id };
  const managerContext = await browser.newContext(); let view: SavedPlannerView;
  try { const manager = await managerContext.newPage(); await signInAs(manager, "manager@cvg.local"); view = await write<SavedPlannerView>(manager, "/planner-views", { name: `Visão sintética ${testInfo.project.name} ${Date.now()}`, sharedDepartmentCode: "INPATIENT", filters, display: PLANNER_DEFAULT_DISPLAY }); } finally { await managerContext.close(); }

  await page.goto("/", { waitUntil: "domcontentloaded" }); await apply(page, view);
  await expect(page.getByRole("status").filter({ hasText: /^1 exames carregados correspondem/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Atalhos", exact: true }).getByRole("link", { name: /Na minha fila\s*1/ })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.getByRole("status").filter({ hasText: /^1 exames carregados correspondem/ })).toBeVisible();

  await page.goto("/queues", { waitUntil: "domcontentloaded" }); await apply(page, view);
  const queueItem = page.getByRole("button", { name: `Abrir ${item.service.name} — Thor`, exact: true });
  await expect(queueItem).toHaveCount(1); await expect(queueItem).toBeVisible();
  await expect(page.getByRole("button", { name: /^Abrir .+ — / })).toHaveCount(1);

  await page.goto("/planner/search", { waitUntil: "domcontentloaded" }); await apply(page, view);
  await page.getByRole("checkbox", { name: "Exame diagnóstico", exact: true }).check();
  await page.getByLabel("Texto, identificação ou paciente", { exact: true }).fill(request.requestCode);
  const read = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/planner/search" && response.request().method() === "GET");
  await page.getByRole("button", { name: "Buscar", exact: true }).click(); const response = await read; expect(response.status()).toBe(200);
  const submitted = Object.fromEntries(new URL(response.url()).searchParams); expect(submitted).toEqual({ ...filters, types: "DIAGNOSTIC_ITEM", query: request.requestCode, limit: "50" });
  const results = (await response.json()).data; expect(results.total).toBe(1); expect(results.items).toEqual([expect.objectContaining({ id: item.id, type: "DIAGNOSTIC_ITEM", responsibleUserId: "user-lab", deepLink: `/requests/${request.id}#${item.id}` })]);
  await expect(page.getByRole("list", { name: "Resultados da busca", exact: true }).getByRole("link")).toHaveCount(1);
});

test("a normal clinician filters a planned diagnostic by its authorized plan and saved phase without changing execution or SLA", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  await signInAs(page, "vet@cvg.local");
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const request = await write<DiagnosticRequestDetail>(page, "/diagnostic-requests", { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", overrideReason: "Cronograma sintético; nenhum atendimento hospitalar real.", items: [{ serviceId: "service-crp" }] });
  expect(request.items).toHaveLength(1);
  const item = request.items[0];
  const now = Date.now();
  const window = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 7_200_000).toISOString() };
  const dates = { plannedStartsAt: new Date(now + 900_000).toISOString(), plannedEndsAt: new Date(now + 1_200_000).toISOString() };
  type ItemState = Pick<DiagnosticRequestDetail["items"][number], "id" | "status" | "version" | "dueAt" | "plannedStartsAt" | "plannedEndsAt">;
  const contextOptions = { baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders, viewport: testInfo.project.use.viewport, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch };
  const labContext = await browser.newContext(contextOptions);
  let planned: ItemState;
  try {
    const lab = await labContext.newPage(); await signInAs(lab, "lab@cvg.local");
    const assigned = await write<{ item: ItemState }>(lab, `/diagnostic-items/${item.id}/assignment`, { userId: "user-lab", expectedVersion: item.version }, "PUT");
    planned = (await write<{ item: ItemState }>(lab, `/diagnostic-items/${item.id}/planning`, { ...dates, expectedVersion: assigned.item.version }, "PUT")).item;
    expect(planned).toMatchObject({ id: item.id, status: item.status, dueAt: item.dueAt, ...dates });
  } finally { await labContext.close(); }
  const plan = await write<HospitalPlanView>(page, "/hospital-plans", { title: `Plano do cronograma ${suffix}`, objective: "Vínculo sintético para filtros autorizados.", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "LABORATORY"], steps: [{ id: "step", title: "Exame planejado", sortOrder: 0 }] });
  const linked = await write<HospitalPlanView>(page, `/hospital-plans/${plan.plan.id}/links`, { stepId: "step", targetType: "DIAGNOSTIC_ITEM", targetId: item.id, active: true, expectedVersion: plan.plan.version }, "PUT");
  expect(linked.activities).toEqual([expect.objectContaining({ targetType: "DIAGNOSTIC_ITEM", targetId: item.id, phase: "PENDING" })]);
  const views: SavedPlannerView[] = [];
  for (const phase of ["PENDING", "IN_PROGRESS"] as const) views.push(await write<SavedPlannerView>(page, "/planner-views", { name: `Cronograma ${phase} ${suffix}`, filters: { ...window, planId: plan.plan.id, phase }, display: PLANNER_DEFAULT_DISPLAY }));

  await page.goto("/planner/timeline", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Cronograma hospitalar", exact: true })).toBeVisible();
  const select = page.getByRole("combobox", { name: "Aplicar filtros de visão salva", exact: true });
  await expect(select.getByRole("option", { name: views[0].name, exact: true })).toBeAttached();
  await select.selectOption(views[0].id);
  await expect(page.getByRole("combobox", { name: "Plano assistencial", exact: true })).toHaveValue(plan.plan.id);
  const diagnostic = page.getByRole("link", { name: `${item.service.name} · ${request.requestCode}`, exact: true });
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toHaveAttribute("href", `/requests/${request.id}`);
  const filteredRead = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/v1/hospital-tasks" && url.searchParams.get("planId") === plan.plan.id && url.searchParams.get("phase") === "IN_PROGRESS" && response.request().method() === "GET"; });
  await select.selectOption(views[1].id);
  expect((await filteredRead).status()).toBe(200);
  await expect(diagnostic).toHaveCount(0);
  const current = await browserGet(page, `/api/v1/diagnostic-items/${item.id}`);
  expect(current.status()).toBe(200);
  expect((await current.json()).data.item).toMatchObject(planned!);
  await select.selectOption(views[0].id);
  await expect(diagnostic).toBeVisible();

  const restrictedContext = await browser.newContext(contextOptions);
  try {
    const restricted = await restrictedContext.newPage(); await signInAs(restricted, "rx@cvg.local");
    const deniedPlan = await browserGet(restricted, `/api/v1/hospital-plans/${plan.plan.id}`);
    expect(deniedPlan.status()).toBe(404);
    const privateViewsRead = restricted.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/planner-views" && response.request().method() === "GET");
    await restricted.goto("/planner/timeline", { waitUntil: "domcontentloaded" });
    await expect(restricted.getByRole("heading", { level: 1, name: "Cronograma hospitalar", exact: true })).toBeVisible();
    const privateViews = await privateViewsRead; expect(privateViews.status()).toBe(200);
    expect((await privateViews.json()).data.map((entry: SavedPlannerView) => entry.id)).not.toContain(views[0].id);
    await expect(restricted.getByRole("option", { name: views[0].name, exact: true })).toHaveCount(0);
    await expect(restricted.getByRole("link", { name: `${item.service.name} · ${request.requestCode}`, exact: true })).toHaveCount(0);
  } finally { await restrictedContext.close(); }
});
