import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { HospitalChecklistTemplateView, HospitalHandoffView, HospitalPlanView, HospitalRecurrenceView, HospitalResource, HospitalSchedule, HospitalShiftView, HospitalTaskPage, HospitalTaskView } from "@cvg/contracts";
import { hospitalDateTimeInput } from "../../src/lib/hospital-time";
import { signInAs } from "./support/auth";
type NativeItem = { id: string; status: string; version: number; dueAt: string };

/** All setup uses the signed-in actor's normal HTTP permissions and current CSRF cookie. */
async function api<T>(page: Page, path: string, method = "GET", body?: object, expectedStatus?: number): Promise<T> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "cvg_csrf")?.value ?? "";
  const response = await page.request.fetch(`/api/v1${path}`, { method, headers: { origin: new URL(page.url()).origin, "x-csrf-token": decodeURIComponent(csrf), "idempotency-key": `continuity-${crypto.randomUUID()}` }, ...(body ? { data: body } : {}) });
  const envelope = await response.json();
  if (expectedStatus) expect(response.status(), `${method} ${path}: ${envelope.error?.code ?? response.status()}`).toBe(expectedStatus);
  else expect(response.ok(), `${method} ${path}: ${envelope.error?.code ?? response.status()}`).toBe(true);
  return envelope.data as T;
}
async function uiCommand<T>(page: Page, path: string, method: string, action: () => Promise<unknown>): Promise<T> {
  const response = page.waitForResponse((entry) => new URL(entry.url()).pathname === `/api/v1${path}` && entry.request().method() === method);
  await action(); const result = await response; const envelope = await result.json();
  expect(result.ok(), `${method} ${path}: ${envelope.error?.code ?? result.status()}`).toBe(true);
  return envelope.data as T;
}
async function selectActivity(form: Locator, query: string, source: "Atividade" | "Exame") {
  await form.getByLabel("Buscar atividade para vincular", { exact: true }).fill(query);
  await form.getByRole("button", { name: new RegExp(`^${source}:`) }).click();
}
async function evidence(info: TestInfo, setupViaAPI: string[], uiActions: string[], actors: string[]) {
  await info.attach("journey-boundaries", { body: JSON.stringify({ syntheticOnly: true, setupViaAPI, uiActions, actors, clinicalApprovalClaimed: false }), contentType: "application/json" });
}

test("a normal clinician creates an interdepartmental plan, links existing work and closes it without closing its sources", async ({ page }, info) => {
  const suffix = `${info.project.name}-${Date.now()}`; const patientName = `Paciente sintético continuidade ${suffix}`; const title = `Plano continuidade ${suffix}`; const taskTitle = `Conferência de materiais ${suffix}`;
  await signInAs(page, "vet@cvg.local");
  const context = await api<{ patient: { id: string }; encounter: { id: string } }>(page, "/patients", "POST", { displayName: patientName, species: "Canino", breed: "SRD", sex: "Macho", ownerLabel: "Responsável sintético", externalId: `SYN-${suffix}`, encounterType: "OUTPATIENT" });
  const native = await api<{ id: string; requestCode: string; items: Array<{ id: string }> }>(page, "/diagnostic-requests", "POST", { patientId: context.patient.id, encounterId: context.encounter.id, priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] });
  const activity = await api<HospitalTaskView>(page, "/hospital-tasks", "POST", { title: taskTitle, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", patientId: context.patient.id, encounterId: context.encounter.id });
  const beforeItem = (await api<{ item: NativeItem }>(page, `/diagnostic-items/${native.items[0].id}`)).item;
  await page.goto("/planner/plans", { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Novo plano", exact: true }).click();
  const form = page.getByRole("form", { name: "Criar plano assistencial", exact: true });
  await form.getByLabel("Título do plano", { exact: true }).fill(title); await form.getByLabel("Objetivo do plano", { exact: true }).fill("Conferir a continuidade dos vínculos autorizados sem executar um exame pelo plano.");
  await form.getByLabel("Buscar paciente ou prontuário", { exact: true }).fill(patientName);
  await form.getByRole("combobox", { name: "Paciente", exact: true }).selectOption(context.patient.id);
  await form.getByRole("combobox", { name: "Atendimento", exact: true }).selectOption(context.encounter.id);
  await form.getByRole("checkbox", { name: "Internação", exact: true }).check(); await form.getByRole("checkbox", { name: "Laboratório", exact: true }).check();
  await form.getByLabel("Etapa 1", { exact: true }).fill("Conferência operacional"); await form.getByRole("button", { name: "Adicionar etapa", exact: true }).click(); await form.getByLabel("Etapa 2", { exact: true }).fill("Diagnóstico original");
  let plan = await uiCommand<HospitalPlanView>(page, "/hospital-plans", "POST", () => form.getByRole("button", { name: "Salvar plano", exact: true }).click());
  expect(plan.plan.departmentCodes).toEqual(expect.arrayContaining(["INPATIENT", "LABORATORY"]));
  await page.getByRole("link", { name: `Abrir ${title}`, exact: true }).click(); await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await selectActivity(page.locator("section").filter({ has: page.getByRole("heading", { name: "Vincular tarefa ou exame existente", exact: true }) }), taskTitle, "Atividade");
  plan = await uiCommand<HospitalPlanView>(page, `/hospital-plans/${plan.plan.id}/links`, "PUT", () => page.getByRole("button", { name: "Vincular à etapa", exact: true }).click());
  await page.getByRole("combobox", { name: "Etapa de destino", exact: true }).selectOption(plan.plan.steps[1].id);
  await selectActivity(page.locator("section").filter({ has: page.getByRole("heading", { name: "Vincular tarefa ou exame existente", exact: true }) }), native.requestCode, "Exame");
  plan = await uiCommand<HospitalPlanView>(page, `/hospital-plans/${plan.plan.id}/links`, "PUT", () => page.getByRole("button", { name: "Vincular à etapa", exact: true }).click());
  expect(plan.summary).toMatchObject({ visibleActivities: 2, completedActivities: 0, pendingActivities: 2 });
  await expect(page.getByText("0 de 2 atividades únicas autorizadas concluídas; 2 não concluídas · 0 bloqueadas.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Encerrar plano", exact: true }).click();
  const close = page.getByRole("form", { name: "Confirmar ciclo de vida do plano", exact: true }); await close.getByLabel("Motivo do encerramento ou arquivo", { exact: true }).fill("Plano sintético encerrado; fontes continuam pendentes.");
  plan = await uiCommand<HospitalPlanView>(page, `/hospital-plans/${plan.plan.id}/commands`, "POST", () => close.getByRole("button", { name: "Confirmar encerramento do plano", exact: true }).click());
  expect(plan.plan.state).toBe("CLOSED"); expect((await api<HospitalTaskView>(page, `/hospital-tasks/${activity.task.id}`)).task).toEqual(activity.task); expect((await api<{ item: NativeItem }>(page, `/diagnostic-items/${beforeItem.id}`)).item).toEqual(beforeItem);
  await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.getByText(/2 não concluídas · 0 bloqueadas/)).toBeVisible();
  await evidence(info, ["Paciente externo e atendimento aberto", "Solicitação diagnóstica nativa", "Atividade operacional contextualizada"], ["Criar plano intersetorial", "Vincular tarefa e exame em etapas distintas", "Consultar pendências", "Encerrar e recarregar sem alterar fontes"], ["VETERINARIAN"]);
});

test("a normal manager creates adjacent shifts, assigns work and waits for the nominal recipient's own acceptance", async ({ page, browser }, info) => {
  const suffix = `${info.project.name}-${Date.now()}`; const taskTitle = `Pendência de passagem ${suffix}`; const base = Math.floor(Date.now() / 60_000) * 60_000 + 86_400_000;
  await signInAs(page, "manager@cvg.local");
  const original = await api<HospitalTaskView>(page, "/hospital-tasks", "POST", { title: taskTitle, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "URGENT", responsibleUserId: "user-manager", plannedStartAt: new Date(base).toISOString(), plannedEndAt: new Date(base + 7_200_000).toISOString() });
  const shifts: HospitalShiftView[] = [];
  for (const [index, name, person] of [[0, `Origem ${suffix}`, "Gestão Operacional"], [1, `Destino ${suffix}`, "Dra. Marina Costa"]] as const) {
    await page.goto("/planner/shifts", { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Novo plantão", exact: true }).click(); const form = page.getByRole("form", { name: "Criar plantão", exact: true });
    await form.getByLabel("Nome do plantão", { exact: true }).fill(name); await form.getByRole("combobox", { name: "Setor do plantão", exact: true }).selectOption("INPATIENT");
    await form.getByLabel("Início do plantão", { exact: true }).fill(hospitalDateTimeInput(new Date(base + index * 3_600_000).toISOString())); await form.getByLabel("Fim do plantão", { exact: true }).fill(hospitalDateTimeInput(new Date(base + (index + 1) * 3_600_000).toISOString())); await form.getByRole("checkbox", { name: person, exact: true }).check();
    shifts.push(await uiCommand<HospitalShiftView>(page, "/hospital-shifts", "POST", () => form.getByRole("button", { name: "Salvar plantão", exact: true }).click()));
  }
  expect(shifts[0].shift.endAt).toBe(shifts[1].shift.startAt);
  await page.goto(`/planner/shifts/${shifts[0].shift.id}`, { waitUntil: "domcontentloaded" }); await selectActivity(page.locator("section").filter({ has: page.getByRole("heading", { name: "Vincular ou transferir atividade para este plantão", exact: true }) }), taskTitle, "Atividade");
  await uiCommand(page, "/hospital-activities/shift", "PUT", () => page.getByRole("button", { name: "Vincular ao plantão", exact: true }).click());
  await page.getByRole("link", { name: "Abrir passagem de plantão", exact: true }).click(); await page.getByRole("button", { name: "Oferecer passagem", exact: true }).click(); const form = page.getByRole("form", { name: "Oferecer passagem de plantão", exact: true });
  await form.getByRole("combobox", { name: "Plantão de origem", exact: true }).selectOption(shifts[0].shift.id); await form.getByRole("combobox", { name: "Plantão de destino", exact: true }).selectOption(shifts[1].shift.id); await form.getByRole("combobox", { name: "Recebedor elegível", exact: true }).selectOption("user-vet"); await selectActivity(form, taskTitle, "Atividade");
  const offered = await uiCommand<HospitalHandoffView>(page, "/hospital-handoffs", "POST", () => form.getByRole("button", { name: "Enviar para aceite", exact: true }).click());
  const before = (await api<HospitalTaskView>(page, `/hospital-tasks/${original.task.id}`)).task;
  expect(before).toMatchObject({ responsibleUserId: "user-manager", shiftId: shifts[0].shift.id, phase: "PENDING", priority: "URGENT" });
  await expect(page.locator(`[id="handoff-${offered.handoff.id}"]`).getByRole("button", { name: "Aceitar passagem", exact: true })).toHaveCount(0);
  await api(page, `/hospital-handoffs/${offered.handoff.id}/decision`, "POST", { decision: "ACCEPT", expectedVersion: offered.handoff.version }, 404);
  const receiver = await browser.newContext({ baseURL: info.project.use.baseURL, extraHTTPHeaders: info.project.use.extraHTTPHeaders, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  try {
    const target = await receiver.newPage(); await signInAs(target, "vet@cvg.local"); await target.goto(`/planner/handoffs?handoffId=${offered.handoff.id}`, { waitUntil: "domcontentloaded" }); const row = target.locator(`[id="handoff-${offered.handoff.id}"]`);
    await row.getByRole("button", { name: "Aceitar passagem", exact: true }).click();
    const accepted = await uiCommand<HospitalHandoffView>(target, `/hospital-handoffs/${offered.handoff.id}/decision`, "POST", () => row.getByRole("form", { name: "Confirmar recebimento de pendências", exact: true }).getByRole("button", { name: "Confirmar aceite", exact: true }).click());
    expect(accepted.handoff).toMatchObject({ state: "ACCEPTED", decidedBy: "user-vet" });
    const after = (await api<HospitalTaskView>(target, `/hospital-tasks/${original.task.id}`)).task;
    expect(after).toMatchObject({ authorId: before.authorId, responsibleUserId: "user-vet", shiftId: shifts[1].shift.id, phase: before.phase, status: before.status, priority: before.priority, plannedStartAt: before.plannedStartAt, plannedEndAt: before.plannedEndAt, version: before.version + 1 });
    await target.reload({ waitUntil: "domcontentloaded" }); await expect(target.locator(`[id="handoff-${offered.handoff.id}"]`).getByText(/Aceite registrado/)).toBeVisible();
  } finally { await receiver.close(); }
  await evidence(info, ["Atividade pendente com responsável e planejamento"], ["Criar dois plantões adjacentes", "Vincular atividade", "Oferecer passagem", "Recusa HTTP do gestor não destinatário", "Aceite UI na própria conta do recebedor", "Recarregar evidência"], ["MANAGER", "VETERINARIAN"]);
});

test("operational checklist recurrence reserves real inventory, shares hospital time across devices and completes with evidence", async ({ page, browser }, info) => {
  const suffix = `${info.project.name}-${Date.now()}`; const title = `Rotina operacional recorrente ${suffix}`; const modelName = `Modelo operacional ${suffix}`; const now = Math.floor(Date.now() / 60_000) * 60_000;
  const startsAt = new Date(now - 300_000).toISOString(); const endsAt = new Date(now + 3_600_000).toISOString();
  await signInAs(page, "manager@cvg.local");
  const resource = await api<HospitalResource>(page, "/hospital-resources", "POST", { code: `ROOM-${suffix}`, name: `Sala operacional ${suffix}`, departmentCode: "INPATIENT", kind: "ROOM", availability: "AVAILABLE", availabilityWindows: [{ startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 7_200_000).toISOString() }] });
  const draft = await api<HospitalChecklistTemplateView>(page, "/hospital-checklist-templates", "POST", { code: `OPS_${suffix.replace(/-/g, "_")}`, name: modelName, departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "SUPPLIES", label: "Conferir materiais operacionais", required: true, evidenceRequired: true }] });
  await page.goto(`/planner/checklists?templateId=${draft.template.id}`, { waitUntil: "domcontentloaded" }); const templateRow = page.locator(`[id="checklist-${draft.template.id}"]`); await templateRow.getByRole("button", { name: `Aprovar ${modelName}`, exact: true }).click();
  const approved = await uiCommand<HospitalChecklistTemplateView>(page, `/hospital-checklist-templates/${draft.template.id}/approve`, "POST", () => templateRow.getByRole("button", { name: "Confirmar aprovação", exact: true }).click()); expect(approved.template.status).toBe("APPROVED"); expect(approved.template.clinicalProcess).toBeUndefined();
  await page.goto("/planner/recurrences", { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Nova recorrência", exact: true }).click(); const form = page.getByRole("form", { name: "Salvar recorrência", exact: true });
  await form.getByLabel("Título da rotina", { exact: true }).fill(title); await form.getByRole("combobox", { name: "Modelo aprovado", exact: true }).selectOption(approved.template.id); await form.getByRole("combobox", { name: "Setor da rotina", exact: true }).selectOption("INPATIENT"); await form.getByLabel("Primeira ocorrência", { exact: true }).fill(hospitalDateTimeInput(new Date(now - 120_000).toISOString())); await form.getByLabel("Intervalo em minutos", { exact: true }).fill("60"); await form.getByRole("combobox", { name: "Responsável da rotina", exact: true }).selectOption("user-manager"); await form.getByLabel("Fim da recorrência", { exact: true }).fill(hospitalDateTimeInput(new Date(now + 30 * 60_000).toISOString()));
  const recurrence = await uiCommand<HospitalRecurrenceView>(page, "/hospital-recurrences", "POST", () => form.getByRole("button", { name: "Salvar recorrência", exact: true }).click());
  await uiCommand(page, "/hospital-recurrences/generate", "POST", () => page.getByRole("button", { name: "Processar ocorrências pendentes", exact: true }).click());
  const tasks = await api<HospitalTaskPage>(page, `/hospital-tasks?query=${encodeURIComponent(title)}&limit=100`); const occurrences = tasks.items.filter((view) => view.task.recurrenceId === recurrence.recurrence.id); expect(occurrences).toHaveLength(1); const task = occurrences[0];
  await page.goto(`/planner/tasks/${task.task.id}`, { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Reservar recursos", exact: true }).click(); const reserve = page.getByRole("form", { name: "Reservar recursos da atividade", exact: true }); await reserve.getByLabel("Início da reserva", { exact: true }).fill(hospitalDateTimeInput(startsAt)); await reserve.getByLabel("Fim da reserva", { exact: true }).fill(hospitalDateTimeInput(endsAt)); await reserve.getByRole("checkbox", { name: new RegExp(`^Sala operacional ${suffix} · ${resource.code}`) }).check();
  const reservation = await uiCommand<HospitalSchedule>(page, `/hospital-tasks/${task.task.id}/reservations`, "POST", () => reserve.getByRole("button", { name: "Confirmar reserva", exact: true }).click()); expect(reservation).toMatchObject({ startsAt, endsAt, resourceIds: [resource.id] });
  const nativeTime = await page.getByText(/^Reserva vigente:/).innerText();
  const tokyo = await browser.newContext({ baseURL: info.project.use.baseURL, extraHTTPHeaders: info.project.use.extraHTTPHeaders, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, timezoneId: "Asia/Tokyo", storageState: await page.context().storageState() });
  try {
    const other = await tokyo.newPage(); await other.goto(`/planner/tasks/${task.task.id}`, { waitUntil: "domcontentloaded" }); await expect(other.getByText(/^Reserva vigente:/)).toHaveText(nativeTime);
    const rival = await api<HospitalTaskView>(other, "/hospital-tasks", "POST", { title: `Reserva concorrente ${suffix}`, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" }); await api(other, `/hospital-tasks/${rival.task.id}/reservations`, "POST", { startsAt, endsAt, resourceIds: [resource.id], expectedVersion: rival.task.version }, 409);
    expect((await api<HospitalTaskView>(other, `/hospital-tasks/${rival.task.id}`)).reservations).toEqual([]);
    await other.goto("/planner/agenda", { waitUntil: "domcontentloaded" }); await other.getByRole("combobox", { name: "Fonte do evento", exact: true }).selectOption("RESERVATION"); await other.getByRole("button", { name: "Aplicar período", exact: true }).click(); await expect(other.getByRole("link", { name: title, exact: true })).toBeVisible();
  } finally { await tokyo.close(); }
  await page.getByRole("button", { name: "Iniciar atividade", exact: true }).click(); await uiCommand(page, `/hospital-tasks/${task.task.id}/commands`, "POST", () => page.getByRole("form", { name: "Confirmar comando da atividade", exact: true }).getByRole("button", { name: "Confirmar início", exact: true }).click());
  await page.getByRole("button", { name: "Registrar etapa Conferir materiais operacionais", exact: true }).click(); const step = page.getByRole("form", { name: "Registrar etapa Conferir materiais operacionais", exact: true }); await step.getByLabel("Evidência da etapa", { exact: true }).fill("Materiais sintéticos conferidos pelo executor desta rotina operacional."); await uiCommand(page, `/hospital-tasks/${task.task.id}/checklist-steps`, "POST", () => step.getByRole("button", { name: "Confirmar registro da etapa", exact: true }).click());
  await page.getByRole("button", { name: "Concluir atividade", exact: true }).click(); const finished = await uiCommand<HospitalTaskView>(page, `/hospital-tasks/${task.task.id}/commands`, "POST", () => page.getByRole("form", { name: "Confirmar comando da atividade", exact: true }).getByRole("button", { name: "Confirmar conclusão", exact: true }).click());
  expect(finished.task).toMatchObject({ phase: "COMPLETED", completedBy: "user-manager", checklistSnapshot: { templateId: approved.template.id, templateVersion: approved.template.version }, checklistExecutions: [expect.objectContaining({ stepCode: "SUPPLIES", actorId: "user-manager", status: "DONE" })] }); expect(finished.task.careExecution).toBeUndefined();
  await evidence(info, ["Inventário real sintético com janela explícita", "Modelo operacional em rascunho, sem clinicalProcess", "Atividade rival pela mesma conta autorizada"], ["Aprovar modelo operacional", "Criar recorrência e gerar ocorrência única", "Reservar recurso cadastrado", "Conferir horário hospitalar em dispositivo Tokyo", "Conflito HTTP sem segunda reserva", "Consultar reserva na agenda", "Iniciar, registrar evidência e concluir pela UI"], ["MANAGER"]);
});
