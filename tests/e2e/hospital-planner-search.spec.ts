import { expect, test, type Page } from "@playwright/test";
import type { DiagnosticRequestDetail, HospitalChecklistTemplateView, HospitalDocumentView, HospitalResource, HospitalRecurrenceView, PatientDiagnosticsResult, PlannerSearchPage, PlannerSearchResult, SessionResponse } from "@cvg/contracts";
import { signInAs } from "./support/auth";
import { browserGet } from "./support/browser-request";

async function command<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.post(`/api/v1${path}`, {
    headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": `planner-search-${Date.now()}-${Math.random()}`, ...(path === "/diagnostic-requests" ? { "x-duplicate-override": "true" } : {}) },
    data
  });
  expect(response.ok(), `POST ${path}: ${response.status()}`).toBe(true);
  return (await response.json()).data as T;
}

async function search(page: Page, query: string, type: PlannerSearchResult["type"], typeLabel: string, id: string, deepLink: string) {
  await page.goto("/planner/search", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Busca do planner", exact: true, level: 1 })).toBeVisible();
  const form = page.getByRole("form", { name: "Pesquisar no planner", exact: true });
  await form.getByRole("button", { name: "Limpar filtros da busca", exact: true }).click();
  await form.getByRole("checkbox", { name: typeLabel, exact: true }).check();
  await form.getByLabel("Texto, identificação ou paciente", { exact: true }).fill(query);
  const searched = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/planner/search" && url.searchParams.get("query") === query && url.searchParams.get("types") === type && response.request().method() === "GET";
  });
  await form.getByRole("button", { name: "Buscar", exact: true }).click();
  const response = await searched;
  expect(response.status()).toBe(200);
  const results = (await response.json()).data as PlannerSearchPage;
  expect(results.items.filter(entry => entry.id === id)).toEqual([expect.objectContaining({ id, type, deepLink })]);
  const link = page.getByRole("list", { name: "Resultados da busca", exact: true }).locator(`a[href="${deepLink}"]`);
  await expect(link).toHaveCount(1);
  await expect(link).toBeVisible();
  return link;
}

test("normal clinician opens the exact authorized document and resource found in the common search", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}_${Date.now()}`;
  // Technical administration prepares synthetic inventory only. The search and native destinations are operated by the normal clinician.
  const setup = await browser.newContext(); let document: HospitalDocumentView; let resource: HospitalResource;
  try {
    const admin = await setup.newPage(); await signInAs(admin, "admin@cvg.local", /Administração técnica/);
    document = await command<HospitalDocumentView>(admin, "/hospital-documents", { code: `META_DOC_${suffix}`, title: `Documento da busca ${suffix}`, departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Conteúdo privado da jornada sintética; não deve ser retornado no índice de busca." }] }] } });
    resource = await command<HospitalResource>(admin, "/hospital-resources", { code: `META_ROOM_${suffix}`, name: `Sala da busca ${suffix}`, kind: "ROOM", departmentCode: "INPATIENT" });
  } finally { await setup.close(); }
  await signInAs(page, "vet@cvg.local");
  const documentLink = `/planner/documents/${document.document.id}`;
  const doc = await search(page, document.document.code, "HOSPITAL_DOCUMENT", "Documento operacional", document.document.id, documentLink);
  const docRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/hospital-documents/${document.document.id}` && response.request().method() === "GET");
  await doc.click(); await expect(page).toHaveURL(url => url.pathname === documentLink);
  const loadedDoc = await docRead; expect(loadedDoc.status()).toBe(200); expect((await loadedDoc.json()).data.document.id).toBe(document.document.id);
  await expect(page.getByRole("heading", { name: document.document.title, exact: true, level: 1 })).toBeVisible();
  const resourceLink = `/admin/resources?resourceId=${resource.id}`;
  const room = await search(page, resource.code, "HOSPITAL_RESOURCE", "Recurso hospitalar", resource.id, resourceLink);
  const inventoryRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-resources" && response.request().method() === "GET");
  await room.click(); await expect(page).toHaveURL(url => url.pathname === "/admin/resources" && url.searchParams.get("resourceId") === resource.id);
  expect((await inventoryRead).status()).toBe(200); const selected = page.locator(`article[id="resource-${resource.id}"]`);
  await expect(selected.getByRole("heading", { name: resource.name, exact: true })).toBeVisible(); await expect(selected).toBeFocused();
});

test("normal clinician follows search results to the authorized diagnostic item, checklist, recurrence, patient and encounter", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await signInAs(page, "vet@cvg.local");
  const sessionResponse = await browserGet(page, "/api/v1/session/me");
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()).data as SessionResponse;
  expect(session.user?.role).toBe("VETERINARIAN");

  const suffix = `${testInfo.project.name}_${Date.now()}`;
  const request = await command<DiagnosticRequestDetail>(page, "/diagnostic-requests", {
    patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE",
    overrideReason: "Repetição autorizada exclusivamente para esta jornada sintética de referências da busca.",
    items: [{ serviceId: "service-crp" }]
  });
  expect(request.items).toHaveLength(1);
  const itemId = request.items[0].id;
  // This operational fixture does not assert a homologated clinical care protocol.
  const draft = await command<HospitalChecklistTemplateView>(page, "/hospital-checklist-templates", {
    code: `SEARCH_${suffix}`, name: `Modelo operacional de busca ${suffix}`, departmentCode: "INPATIENT", careContextRequired: false,
    steps: [{ code: "REFERENCE_CHECK", label: "Conferir a referência sintética", required: true, evidenceRequired: false }]
  });
  const approved = await command<HospitalChecklistTemplateView>(page, `/hospital-checklist-templates/${draft.template.id}/approve`, { expectedVersion: draft.template.version });
  expect(approved.template.status).toBe("APPROVED");
  expect(approved.template.approvedBy).toBe(session.user?.id);
  const recurrence = await command<HospitalRecurrenceView>(page, "/hospital-recurrences", {
    templateId: approved.template.id, departmentCode: "INPATIENT", title: `Rotina operacional de busca ${suffix}`, priority: "ROUTINE",
    responsibleUserId: session.user?.id, startAt: new Date(Date.now() + 86_400_000).toISOString(), intervalMinutes: 60
  });

  const itemLink = `/requests/${request.id}#${itemId}`;
  const diagnostic = await search(page, request.requestCode, "DIAGNOSTIC_ITEM", "Exame diagnóstico", itemId, itemLink);
  const requestRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/diagnostic-requests/${request.id}` && response.request().method() === "GET");
  await diagnostic.click();
  await expect(page).toHaveURL(url => url.pathname === `/requests/${request.id}` && url.hash === `#${itemId}`);
  const requestResponse = await requestRead;
  expect(requestResponse.status()).toBe(200);
  const detail = (await requestResponse.json()).data as DiagnosticRequestDetail;
  expect(detail.id).toBe(request.id);
  expect(detail.items.map(item => item.id)).toEqual([itemId]);
  await expect(page.locator(`article[id="${itemId}"]`).getByRole("heading", { name: detail.items[0].service.name, exact: true })).toBeVisible();

  const templateLink = `/planner/checklists?templateId=${approved.template.id}`;
  const checklist = await search(page, approved.template.code, "CHECKLIST_TEMPLATE", "Modelo de checklist", approved.template.id, templateLink);
  const templatesRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-checklist-templates" && response.request().method() === "GET");
  await checklist.click();
  await expect(page).toHaveURL(url => url.pathname === "/planner/checklists" && url.searchParams.get("templateId") === approved.template.id);
  const templatesResponse = await templatesRead;
  expect(templatesResponse.status()).toBe(200);
  const templates = (await templatesResponse.json()).data as { items: HospitalChecklistTemplateView[] };
  expect(templates.items.find(view => view.template.id === approved.template.id)?.template).toEqual(approved.template);
  const selectedTemplate = page.locator(`article[id="checklist-${approved.template.id}"]`);
  await expect(selectedTemplate.getByRole("heading", { name: approved.template.name, exact: true })).toBeVisible();
  await expect(selectedTemplate).toBeFocused();

  const recurrenceLink = `/planner/recurrences?recurrenceId=${recurrence.recurrence.id}`;
  const routine = await search(page, recurrence.recurrence.title, "HOSPITAL_RECURRENCE", "Rotina recorrente", recurrence.recurrence.id, recurrenceLink);
  const recurrencesRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-recurrences" && response.request().method() === "GET");
  await routine.click();
  await expect(page).toHaveURL(url => url.pathname === "/planner/recurrences" && url.searchParams.get("recurrenceId") === recurrence.recurrence.id);
  const recurrencesResponse = await recurrencesRead;
  expect(recurrencesResponse.status()).toBe(200);
  const recurrences = (await recurrencesResponse.json()).data as { items: HospitalRecurrenceView[] };
  expect(recurrences.items.find(view => view.recurrence.id === recurrence.recurrence.id)?.recurrence).toEqual(recurrence.recurrence);
  const selectedRecurrence = page.locator(`article[id="recurrence-${recurrence.recurrence.id}"]`);
  await expect(selectedRecurrence.getByRole("heading", { name: recurrence.recurrence.title, exact: true })).toBeVisible();
  await expect(selectedRecurrence).toBeFocused();

  const workspaceResponse = await browserGet(page, "/api/v1/patients/patient-thor/diagnostics?limit=50");
  expect(workspaceResponse.status()).toBe(200);
  const workspace = (await workspaceResponse.json()).data as PatientDiagnosticsResult;
  expect(workspace.patient.id).toBe("patient-thor");
  const encounter = workspace.encounters.find(entry => entry.id === "encounter-thor");
  expect(encounter).toBeDefined();
  if (!encounter) throw new Error("The synthetic current encounter is missing from its authorized workspace.");
  const patientLink = "/patients/patient-thor/diagnostics";
  for (const [type, label, query, id] of [
    ["PATIENT", "Paciente", workspace.patient.externalId, workspace.patient.id],
    ["ENCOUNTER", "Atendimento", encounter.externalId, encounter.id]
  ] as const) {
    const reference = await search(page, query, type, label, id, patientLink);
    const workspaceRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/patients/patient-thor/diagnostics" && response.request().method() === "GET");
    await reference.click();
    await expect(page).toHaveURL(url => url.pathname === patientLink);
    const loadedResponse = await workspaceRead;
    expect(loadedResponse.status()).toBe(200);
    const loaded = (await loadedResponse.json()).data as PatientDiagnosticsResult;
    expect(loaded.patient.id).toBe(workspace.patient.id);
    expect(loaded.encounters).toContainEqual(expect.objectContaining({ id: encounter.id, externalId: encounter.externalId }));
    await expect(page.getByRole("heading", { name: `${workspace.patient.displayName} em acompanhamento.`, exact: true, level: 1 })).toBeVisible();
    // Encounter references open the patient's workspace, where the real encounter remains visible.
    await expect(page.getByRole("region", { name: "Atendimentos do paciente", exact: true }).getByText(encounter.externalId, { exact: true })).toBeVisible();
  }
  expect(pageErrors).toEqual([]);
});
