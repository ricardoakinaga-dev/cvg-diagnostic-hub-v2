import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function setup() {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const user = (email: string) => {
    const actor = store.getState().users.find((entry) => entry.email === email);
    if (!actor) throw new Error(`missing fixture actor: ${email}`);
    return actor;
  };
  return { store, service, vet: user("vet@cvg.local"), lab: user("lab@cvg.local"), rx: user("rx@cvg.local"), us: user("us@cvg.local"), manager: user("manager@cvg.local"), admin: user("admin@cvg.local") };
}

describe("workflow commands", () => {
  it("rejects a stale item version before creating a schedule", async () => {
    const { service, vet, us, store } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "stale-schedule-request" });
    const item = request.items[0];

    await expect(service.scheduleProcedure(us, item.id, {
      startsAt: "2026-08-26T10:00:00.000Z",
      endsAt: "2026-08-26T10:30:00.000Z",
      resource: "US-STALE",
      expectedVersion: item.version + 1,
      idempotencyKey: "stale-schedule"
    })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
    expect(store.getState().procedures).toHaveLength(0);
  });

  it("schedules, reschedules, performs and reports an ultrasound without sample states", async () => {
    const { service, vet, us } = setup();
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-ultrasound" }]
    }, { idempotencyKey: "workflow-us-request" });
    const item = request.items[0];
    const scheduled = await service.scheduleProcedure(us, item.id, {
      startsAt: "2026-08-20T10:00:00.000Z",
      endsAt: "2026-08-20T10:30:00.000Z",
      resource: "US-01",
      expectedVersion: item.version,
      idempotencyKey: "workflow-us-schedule"
    });

    expect(scheduled.item.status).toBe("SCHEDULED");
    expect(scheduled.procedure.status).toBe("SCHEDULED");
    expect(scheduled.schedule.resource).toBe("US-01");

    const rescheduled = await service.rescheduleProcedure(us, scheduled.procedure.id, {
      startsAt: "2026-08-20T11:00:00.000Z",
      endsAt: "2026-08-20T11:30:00.000Z",
      resource: "US-01",
      reason: "Reorganização da agenda",
      expectedVersion: scheduled.procedure.version,
      idempotencyKey: "workflow-us-reschedule"
    });
    expect(rescheduled.schedule.startsAt).toBe("2026-08-20T11:00:00.000Z");
    expect(rescheduled.history).toHaveLength(2);

    const started = await service.startProcedure(us, item.id, { expectedVersion: rescheduled.item.version, idempotencyKey: "workflow-us-start" });
    expect(started.item.status).toBe("IN_PROGRESS");
    const performed = await service.markProcedurePerformed(us, item.id, { expectedVersion: started.item.version, idempotencyKey: "workflow-us-performed" });
    expect(performed.item.status).toBe("AWAITING_REPORT");
    expect(performed.procedure.status).toBe("PERFORMED");
    expect((await service.timeline(vet, request.id)).items.some((event) => event.entityType === "Procedure")).toBe(true);
  });

  it("rejects overlapping schedules and exposes cancellation as an audited state change", async () => {
    const { service, vet, us, store } = setup();
    const first = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "schedule-first-request" });
    const second = await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "schedule-second-request" });
    await service.scheduleProcedure(us, first.items[0].id, { startsAt: "2026-08-21T10:00:00.000Z", endsAt: "2026-08-21T10:30:00.000Z", resource: "US-02", expectedVersion: first.items[0].version, idempotencyKey: "schedule-first" });
    await expect(service.scheduleProcedure(us, second.items[0].id, { startsAt: "2026-08-21T10:15:00.000Z", endsAt: "2026-08-21T10:45:00.000Z", resource: "US-02", expectedVersion: second.items[0].version, idempotencyKey: "schedule-conflict" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT", status: 409 });

    const cancelled = await service.cancelItem(vet, first.items[0].id, { reasonCode: "CLINICAL_DECISION", reason: "Paciente encaminhado para outra conduta", expectedVersion: 2, idempotencyKey: "schedule-cancel" });
    expect(cancelled.item.status).toBe("CANCELLED");
    expect(store.getState().auditEvents.some((event) => event.eventType === "DiagnosticItemCancelled")).toBe(true);
  });

  it("points the item at the pending replacement sample during recollection", async () => {
    const { service, vet, lab } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "recollection-context-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-RECOLLECTION-CONTEXT", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "recollection-context-receive" });
    const recollection = await service.requestRecollection(lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "recollection-context-requested" });

    expect(recollection.items[0].currentSampleId).toBe(recollection.replacement.id);
    expect(recollection.replacement.status).toBe("EXPECTED");
  });

  it("keeps released versions immutable through amend, void and replacement release", async () => {
    const { service, vet, lab, manager, store } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "result-lifecycle-request" });
    const item = request.items[0];
    const received = await service.receiveSample(lab, [item.id], { accessionCode: "ACC-RESULT-1", sampleType: "EDTA", expectedVersion: item.version, idempotencyKey: "result-lifecycle-receive" });
    await service.startProcessing(lab, item.id, { expectedVersion: received.items[0].version, idempotencyKey: "result-lifecycle-start" });
    const draft = await service.createResultDraft(lab, item.id, { narrative: "Resultado inicial.", content: syntheticHemogramContent("Resultado inicial."), expectedVersion: received.items[0].version + 1, idempotencyKey: "result-lifecycle-draft" });
    const released = await service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "result-lifecycle-release" });
    await service.viewResult(vet, released.version.id, { expectedVersion: released.item.version, idempotencyKey: "result-lifecycle-view" });
    const reviewed = await service.reviewResult(vet, released.result.id, { versionId: released.version.id, expectedVersion: released.item.version, idempotencyKey: "result-lifecycle-review" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === manager.id ? { ...user, managedDepartmentCodes: [] } : user) }, result: undefined }));
    const scopedManager = store.getState().users.find((user) => user.id === manager.id);
    if (!scopedManager) throw new Error("scoped manager missing");
    await expect(service.completeItem(scopedManager, item.id, { expectedVersion: reviewed.item.version, idempotencyKey: "result-lifecycle-cross-department" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === manager.id ? { ...user, departmentCode: "LABORATORY", managedDepartmentCodes: [] } : user) }, result: undefined }));
    const laboratoryManager = store.getState().users.find((user) => user.id === manager.id);
    if (!laboratoryManager) throw new Error("scoped manager missing");
    const completed = await service.completeItem(laboratoryManager, item.id, { expectedVersion: reviewed.item.version, idempotencyKey: "result-lifecycle-complete" });
    expect(completed.item.status).toBe("COMPLETED");

    const amended = await service.amendResult(lab, released.result.id, { reason: "Correção de unidade", narrative: "Resultado corrigido.", content: syntheticHemogramContent("Resultado corrigido."), expectedVersion: reviewed.result.version, idempotencyKey: "result-lifecycle-amend" });
    expect(amended.version.status).toBe("DRAFT");
    expect(amended.item.status).toBe("RESULT_VOIDED");
    expect(amended.previousVersion.status).toBe("SUPERSEDED");
    const replacement = await service.releaseResult(lab, amended.result.id, { expectedVersion: amended.result.version, idempotencyKey: "result-lifecycle-release-replacement" });
    expect(replacement.version.sequence).toBe(2);
    const voided = await service.voidResult(laboratoryManager, replacement.result.id, { reason: "Revisão administrativa", expectedVersion: replacement.result.version, idempotencyKey: "result-lifecycle-void" });
    expect(voided.item.status).toBe("RESULT_VOIDED");
    expect(voided.version.status).toBe("VOIDED");
    const postVoidDraft = await service.createResultDraft(lab, item.id, { narrative: "Resultado substituto após invalidação.", content: syntheticHemogramContent("Resultado substituto após invalidação."), expectedVersion: voided.item.version, idempotencyKey: "result-lifecycle-post-void-draft" });
    const postVoidRelease = await service.releaseResult(lab, postVoidDraft.result.id, { expectedVersion: postVoidDraft.result.version, idempotencyKey: "result-lifecycle-post-void-release" });
    expect(postVoidRelease.item.status).toBe("RESULT_AVAILABLE");
  });

  it("blocks a legacy laboratory draft at the release gate", async () => {
    const { service, vet, lab, store } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "legacy-release-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-LEGACY-RELEASE", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "legacy-release-receive" });
    const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "legacy-release-start" });
    const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Draft legado em migração.", content: {}, expectedVersion: started.item.version, idempotencyKey: "legacy-release-draft" });

    await expect(service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "legacy-release-attempt" })).rejects.toMatchObject({ code: "RESULT_RELEASE_BLOCKED", status: 422 });
    expect(store.getState().resultVersions.find((version) => version.id === draft.version.id)).toMatchObject({ status: "DRAFT", content: {} });
  });

  it("validates, snapshots and releases a structured hemogram without inventing clinical thresholds", async () => {
    const { service, vet, lab, store } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "structured-lab-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-STRUCTURED-1", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "structured-lab-receive" });
    const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "structured-lab-start" });
    const incomplete = {
      kind: "LABORATORY_STRUCTURED" as const,
      panelCode: "SYNTHETIC_HEMOGRAM",
      panelVersion: 1,
      observations: [{ analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" }]
    };
    await expect(service.createResultDraft(lab, request.items[0].id, { narrative: "Painel incompleto.", content: incomplete, expectedVersion: started.item.version, idempotencyKey: "structured-lab-invalid" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
    expect(store.getState().results).toHaveLength(0);

    const content = {
      ...incomplete,
      observations: [
        { analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" },
        { analyteCode: "LEUKOCYTES", value: 8.1, unitCode: "10^9/L" },
        { analyteCode: "PLATELETS", value: 240, unitCode: "10^9/L" },
        { analyteCode: "COMMENT", value: "Amostra adequada", unitCode: "TEXT" }
      ]
    };
    const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Hemograma estruturado.", content, expectedVersion: started.item.version, idempotencyKey: "structured-lab-draft" });
    expect(draft.version.content).toMatchObject({ kind: "LABORATORY_STRUCTURED", panelCode: "SYNTHETIC_HEMOGRAM", panelVersion: 1 });
    const normalizedContent = draft.version.content as { observations: Array<Record<string, unknown>> };
    expect(normalizedContent.observations[0]).toMatchObject({ analyteCode: "HEMOGLOBIN", value: 12.4, flag: "UNINTERPRETED", referenceRange: { source: "PENDING_HUMAN_POLICY" } });
    const released = await service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "structured-lab-release" });
    expect(released.version.status).toBe("RELEASED");
    expect(released.version.content).toMatchObject({ kind: "LABORATORY_STRUCTURED" });
    const releasedContent = released.version.content as { observations: Array<Record<string, unknown>> };
    expect(releasedContent.observations).toEqual(expect.arrayContaining([expect.objectContaining({ analyteCode: "PLATELETS", flag: "UNINTERPRETED" })]));
  });

  it("reopens an imaging replacement draft in the report phase", async () => {
    const { service, vet, rx } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "imaging-replacement-request" });
    const started = await service.startProcedure(rx, request.items[0].id, { expectedVersion: request.items[0].version, idempotencyKey: "imaging-replacement-start" });
    const performed = await service.markProcedurePerformed(rx, request.items[0].id, { expectedVersion: started.item.version, idempotencyKey: "imaging-replacement-performed" });
    const draft = await service.createResultDraft(rx, request.items[0].id, { narrative: "Laudo inicial.", content: {}, expectedVersion: performed.item.version, idempotencyKey: "imaging-replacement-draft" });
    const released = await service.releaseResult(rx, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "imaging-replacement-release" });
    const voided = await service.voidResult(rx, released.result.id, { reason: "Correção controlada", expectedVersion: released.result.version, idempotencyKey: "imaging-replacement-void" });

    const replacement = await service.createResultDraft(rx, voided.item.id, { narrative: "Laudo substituto.", content: {}, expectedVersion: voided.item.version, idempotencyKey: "imaging-replacement-draft-2" });
    expect(replacement.item.status).toBe("AWAITING_REPORT");
    const replacementRelease = await service.releaseResult(rx, replacement.result.id, { expectedVersion: replacement.result.version, idempotencyKey: "imaging-replacement-release-2" });
    expect(replacementRelease.item.status).toBe("RESULT_AVAILABLE");
  });
});
