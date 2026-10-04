import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { InProcessEventBus, processOutboxBatch } from "../operations/outbox";
import type { Notification } from "../domain/models";

describe("authorized read models", () => {
  it("re-derives the current actor from the same fresh snapshot used by a read", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const staleActor = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!staleActor) throw new Error("fixture actor missing");

    await store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === staleActor.id ? { ...user, active: false } : user)
      },
      result: undefined
    }));

    await expect(service.getRequest(staleActor, "request-missing")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401
    });
    await expect(service.listServices(staleActor)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401
    });
    await expect(service.dashboard(staleActor)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401
    });
    await expect(service.listPatients(staleActor)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(service.listRequests(staleActor)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(service.getPatient(staleActor, "patient-thor")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(service.timeline(staleActor, "request-missing")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("rejects an in-flight actor after its persisted privileges change", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const staleActor = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!staleActor) throw new Error("fixture actor missing");

    await store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === staleActor.id
          ? { ...user, role: "VIEWER", version: user.version + 1 }
          : user)
      },
      result: undefined
    }));

    await expect(service.getRequest(staleActor, "request-missing")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401
    });
  });

  it("serves scoped catalog, queues, search, timeline and dashboard data", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const actor = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!actor || !lab) throw new Error("fixture actors missing");

    const request = await service.createRequest(actor, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }] }, { idempotencyKey: "read-model-request" });
    const managerRecord = store.getState().users.find((user) => user.email === "manager@cvg.local");
    const viewer = store.getState().users.find((user) => user.email === "admin@cvg.local");
    if (!managerRecord || !viewer) throw new Error("management actors missing");
    const manager = { ...managerRecord, managedDepartmentCodes: [] };
    const services = await service.listServices(actor);
    expect(services.map((entry) => entry.code)).toContain("HEMOGRAM");
    expect((await service.listPatients(actor, "thor")).map((entry) => entry.id)).toEqual(["patient-thor"]);
    expect((await service.listPatients(actor, "does-not-exist"))).toEqual([]);
    expect((await service.getPatient(actor, "patient-thor")).displayName).toBe("Thor");
    await expect(service.getPatient(lab, "patient-does-not-exist")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.getItem(lab, "item-does-not-exist")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    expect((await service.listPatients(manager)).map((entry) => entry.id)).toEqual(["patient-thor"]);
    await expect(service.getPatient(manager, "patient-mel")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.getItem(manager, request.items[0].id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect((await service.listEncounters(actor, "patient-thor")).map((entry) => entry.id)).toEqual(["encounter-thor"]);
    expect((await service.getEncounter(actor, "encounter-thor")).patientId).toBe("patient-thor");
    expect((await service.getAdmission(actor, "admission-thor")).bed).toBe("Box 03");
    expect((await service.getPatient(lab, "patient-thor")).displayName).toBe("Thor");
    await expect(service.getPatient(lab, "patient-mel")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const labRequest = await service.getRequest(lab, request.id);
    expect(labRequest.id).toBe(request.id);
    expect(labRequest.itemIds).toEqual([request.items[0].id]);
    const labItem = await service.getItem(lab, request.items[0].id);
    expect(labItem.service.code).toBe("HEMOGRAM");
    expect(labItem.request.itemIds).toEqual([request.items[0].id]);
    await expect(service.getItem(lab, request.items[1].id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect((await service.timeline(lab, request.id)).items.length).toBeGreaterThan(0);

    const listed = await service.listRequests(actor, { limit: 1 });
    expect(listed.items[0].id).toBe(request.id);
    expect(listed.total).toBe(1);
    await expect(service.listRequests(actor, { cursor: Buffer.from("1").toString("base64url") })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const queue = await service.listQueue(lab, "LABORATORY", { overdue: false });
    expect(queue[0].requestId).toBe(request.id);
    expect(queue[0]).toMatchObject({
      nextAction: "Receber amostra",
      operationalContext: {
        currentOwner: { code: "REQUESTING_TEAM" },
        nextAction: { code: "COLLECT_SAMPLE", label: "Receber amostra" },
        blockedBy: { code: "WAITING_SAMPLE" },
        waitingSince: request.items[0].requestedAt,
        expectedBy: request.items[0].dueAt
      },
      currentOwner: { code: "REQUESTING_TEAM" },
      blockedBy: { code: "WAITING_SAMPLE" },
      waitingSince: request.items[0].requestedAt,
      expectedBy: request.items[0].dueAt,
      escalationLevel: "WATCH"
    });
    expect((await service.search(lab, request.requestCode)).items[0]?.id).toBe(request.id);
    await expect(service.search(actor, "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await service.timeline(actor, request.id)).items.length).toBeGreaterThan(0);
    const firstTimelinePage = await service.timeline(actor, request.id, undefined, { limit: 1 });
    expect(firstTimelinePage.items).toHaveLength(1);
    expect(firstTimelinePage.nextCursor).toBeTruthy();
    const secondTimelinePage = await service.timeline(actor, request.id, undefined, { limit: 1, cursor: firstTimelinePage.nextCursor });
    expect(secondTimelinePage.items[0].id).not.toBe(firstTimelinePage.items[0].id);
    const dashboard = await service.dashboard(actor);
    expect(dashboard.totalActive).toBe(2);
    expect(dashboard.window).toMatchObject({ kind: "CURRENT_STATE", timezone: "America/Sao_Paulo" });
    expect(dashboard.window.asOf).toBe(dashboard.updatedAt);
    expect(dashboard.attention[0]).toMatchObject({
      requestId: request.id,
      patient: { displayName: "Thor" },
      operationalContext: { nextAction: { code: expect.any(String) }, expectedBy: expect.any(String) },
      deepLink: expect.stringContaining(`/requests/${request.id}#`)
    });
    expect(dashboard.departments).toEqual(expect.arrayContaining([
      expect.objectContaining({ departmentCode: "LABORATORY", state: expect.any(String) })
    ]));
    expect(dashboard.dataQuality).toMatchObject({ status: "FRESH", asOf: dashboard.updatedAt });
    expect(dashboard.indicators.map((indicator) => indicator.key)).toEqual([
      "overdue",
      "recollections",
      "newResults",
      "critical",
      "totalActive"
    ]);
    const overdueIndicator = dashboard.indicators.find((indicator) => indicator.key === "overdue");
    expect(overdueIndicator).toMatchObject({
      count: dashboard.overdue,
      denominator: 2,
      definition: expect.stringContaining("não terminais"),
      nextAction: expect.stringContaining("fila")
    });
    const criticalIndicator = dashboard.indicators.find((indicator) => indicator.key === "critical");
    expect(criticalIndicator).toMatchObject({
      count: dashboard.critical,
      denominator: 0,
      definition: expect.stringContaining("Notificações críticas")
    });
    const pagedQueue = await service.listQueuePage(lab, "LABORATORY", { limit: 1 });
    expect(pagedQueue.items).toHaveLength(1);
    expect(pagedQueue.nextCursor).toBeUndefined();
    const secondLabRequest = await service.createRequest(actor, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "read-model-second-lab-request" });
    const firstQueuePage = await service.listQueuePage(lab, "LABORATORY", { limit: 1 });
    expect(firstQueuePage.nextCursor).toBeTruthy();
    const secondQueuePage = await service.listQueuePage(lab, "LABORATORY", { limit: 1, cursor: firstQueuePage.nextCursor });
    expect(secondQueuePage.items).toHaveLength(1);
    expect(secondQueuePage.items[0].id).not.toBe(firstQueuePage.items[0].id);
    expect(secondQueuePage.items[0].requestId).toBe(secondLabRequest.id);
    await expect(service.listQueuePage(lab, "LABORATORY", { cursor: Buffer.from("invalid").toString("base64url") })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await service.dashboard(manager)).totalActive).toBe(0);

    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-READ-1", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "read-model-receive" });
    await service.requestRecollection(lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "read-model-recollect" });
    expect((await service.listNotifications(actor, "ACTIONABLE")).items).toHaveLength(1);
    expect((await service.listNotifications(actor, "UNREAD")).items).toHaveLength(1);
    const pendingNotification = (await service.listNotifications(actor)).items[0];
    await expect(service.acknowledgeNotification(actor, pendingNotification.id, { expectedVersion: pendingNotification.version, reason: "Confirmação prematura", confirm: true, idempotencyKey: "read-model-pending-ack" })).rejects.toMatchObject({ code: "NOTIFICATION_NOT_DELIVERED" });
    await processOutboxBatch(store, new InProcessEventBus(), { now: () => new Date(Date.now() + 1_000), batchSize: 50, allowSyntheticDelivery: true });
    const notification = (await service.listNotifications(actor)).items[0];
    await expect(service.acknowledgeNotification(actor, notification.id, {} as never)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await service.acknowledgeNotification(actor, notification.id, { expectedVersion: notification.version, reason: "Confirmei a recoleta no contexto autorizado.", confirm: true, idempotencyKey: "read-model-ack" });
    expect((await service.listNotifications(actor, "UNREAD")).items).toHaveLength(0);

    const viewerNotification: Notification = {
      id: "notification-viewer",
      category: "ACTIONABLE",
      priority: "HIGH",
      recipientUserId: viewer.id,
      entityType: "REQUEST",
      entityId: request.id,
      deepLink: `/requests/${request.id}`,
      title: "Ação necessária",
      body: "Confirmação de teste",
      dedupeKey: "viewer-notification",
      state: "DELIVERED",
      createdAt: new Date().toISOString(),
      attempts: 0,
      version: 1
    };
    await store.transaction((state) => ({ state: { ...state, notifications: [...state.notifications, viewerNotification] }, result: undefined }));
    await expect(service.acknowledgeNotification(viewer, viewerNotification.id, { expectedVersion: viewerNotification.version, reason: "Confirmação de teste", confirm: true, idempotencyKey: "viewer-ack" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const foreignNotification = { ...viewerNotification, id: "notification-foreign", entityId: "request-not-found", dedupeKey: "foreign-notification" };
    await store.transaction((state) => ({ state: { ...state, notifications: [...state.notifications, foreignNotification] }, result: undefined }));
    await expect(service.acknowledgeNotification(manager, foreignNotification.id, { expectedVersion: foreignNotification.version, reason: "Confirmação de teste", confirm: true, idempotencyKey: "manager-foreign-ack" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps attention projection meaningful and server-scoped", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    const rx = store.getState().users.find((user) => user.email === "rx@cvg.local");
    if (!vet || !lab || !rx) throw new Error("fixture actors missing");

    await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "attention-routine" });
    const urgent = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "attention-urgent" });
    const emergency = await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "EMERGENCY", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "attention-emergency" });
    await store.transaction((state) => ({
      state: {
        ...state,
        items: state.items.map((item) => item.id === emergency.items[0].id ? { ...item, dueAt: "2026-08-20T10:00:00.000Z" } : item)
      },
      result: undefined
    }));

    const dashboard = await service.dashboard(vet);
    expect(dashboard.attention.map((item) => item.operationalContext.escalationLevel)).toEqual(["URGENT", "WATCH"]);
    expect(dashboard.attention.every((item) => item.operationalContext.escalationLevel !== "NONE")).toBe(true);
    expect(dashboard.attention.map((item) => item.id)).toEqual([emergency.items[0].id, urgent.items[0].id]);
    expect((await service.listQueue(lab, "LABORATORY")).every((item) => item.departmentCode === "LABORATORY")).toBe(true);
    expect((await service.listQueue(rx, "RADIOLOGY")).every((item) => item.departmentCode === "RADIOLOGY")).toBe(true);
    await expect(service.listQueue(lab, "RADIOLOGY")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("labels each workflow queue with its next server-side action", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    const rx = store.getState().users.find((user) => user.email === "rx@cvg.local");
    const us = store.getState().users.find((user) => user.email === "us@cvg.local");
    if (!vet || !lab || !rx || !us) throw new Error("fixture actors missing");

    const labRequest = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "action-lab-request" });
    expect((await service.listQueue(lab, "LABORATORY"))[0].nextAction).toBe("Receber amostra");
    const received = await service.receiveSample(lab, [labRequest.items[0].id], { accessionCode: "ACC-ACTION-1", sampleType: "EDTA", expectedVersion: labRequest.items[0].version, idempotencyKey: "action-receive" });
    expect((await service.listQueue(lab, "LABORATORY"))[0].nextAction).toBe("Iniciar processamento");
    await service.startProcessing(lab, labRequest.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "action-start" });
    expect((await service.listQueue(lab, "LABORATORY"))[0].nextAction).toBe("Registrar resultado");
    const draft = await service.createResultDraft(lab, labRequest.items[0].id, { narrative: "Ação", content: syntheticHemogramContent(), expectedVersion: received.items[0].version + 1, idempotencyKey: "action-draft" });
    await service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "action-release" });
    expect((await service.listQueue(lab, "LABORATORY"))[0].nextAction).toBe("Revisar resultado");

    const rxRequest = await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "action-rx-request" });
    expect((await service.listQueue(rx, "RADIOLOGY"))[0].nextAction).toBe("Encaminhar paciente");
    const rxStarted = await service.startProcedure(rx, rxRequest.items[0].id, { expectedVersion: rxRequest.items[0].version, idempotencyKey: "action-rx-start" });
    expect((await service.listQueue(rx, "RADIOLOGY"))[0].nextAction).toBe("Marcar exame realizado");
    const performed = await service.markProcedurePerformed(rx, rxRequest.items[0].id, { expectedVersion: rxStarted.item.version, idempotencyKey: "action-rx-performed" });
    expect((await service.listQueue(rx, "RADIOLOGY"))[0].nextAction).toBe("Produzir laudo");
    await service.createResultDraft(rx, rxRequest.items[0].id, { narrative: "Laudo", content: {}, expectedVersion: performed.item.version, idempotencyKey: "action-rx-draft" });
    expect(performed.item.status).toBe("AWAITING_REPORT");

    const usRequest = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "EMERGENCY", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "action-us-request" });
    expect((await service.listQueue(us, "ULTRASOUND"))[0].nextAction).toBe("Agendar exame");
    const scheduled = await service.scheduleProcedure(us, usRequest.items[0].id, { startsAt: "2026-08-25T10:00:00.000Z", endsAt: "2026-08-25T10:30:00.000Z", resource: "US-ACTION", expectedVersion: usRequest.items[0].version, idempotencyKey: "action-us-schedule" });
    expect((await service.listQueue(us, "ULTRASOUND"))[0].nextAction).toBe("Acompanhar item");
    expect(scheduled.item.status).toBe("SCHEDULED");
  });

  it("counts only released and not-yet-reviewed results as new", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!vet || !lab) throw new Error("fixture actors missing");

    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "dashboard-new-result-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-DASH-NEW", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "dashboard-new-result-receive" });
    const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "dashboard-new-result-start" });
    const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Dashboard", content: syntheticHemogramContent(), expectedVersion: started.item.version, idempotencyKey: "dashboard-new-result-draft" });
    const released = await service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "dashboard-new-result-release" });
    const beforeReview = await service.dashboard(vet);
    expect(beforeReview.newResults).toBeGreaterThan(0);
    await service.viewResult(vet, draft.version.id, { expectedVersion: released.item.version, idempotencyKey: "dashboard-new-result-view" });
    await service.reviewResult(vet, draft.result.id, { versionId: draft.version.id, idempotencyKey: "dashboard-new-result-review", expectedVersion: released.item.version });
    const afterReview = await service.dashboard(vet);
    expect(afterReview.newResults).toBe(beforeReview.newResults - 1);
  });

  it("restricts and audits user role administration", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const admin = store.getState().users.find((user) => user.email === "admin@cvg.local");
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!admin || !vet) throw new Error("fixture actors missing");

    expect((await service.listManagedUsers(admin)).find((user) => user.id === vet.id)).toMatchObject({ role: "VETERINARIAN", active: true });
    await expect(service.listManagedUsers(vet)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const updated = await service.updateUserRole(admin, vet.id, { role: "MANAGER", departmentCode: "INPATIENT", active: true, expectedVersion: 1, reason: "Atualizar acesso operacional", confirm: true, idempotencyKey: "role-admin-update" });
    expect(updated).toMatchObject({ id: vet.id, role: "MANAGER", departmentCode: "INPATIENT", version: 2 });
    expect(store.getState().auditEvents.at(-1)?.eventType).toBe("UserRoleUpdated");
    await expect(service.updateUserRole(admin, vet.id, { role: "VIEWER", departmentCode: "INPATIENT", expectedVersion: 1, reason: "Atualizar acesso operacional", confirm: true, idempotencyKey: "role-stale-update" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(service.updateUserRole(admin, admin.id, { role: "VIEWER", departmentCode: "IT", active: true, expectedVersion: 1, reason: "Alteração indevida", confirm: true, idempotencyKey: "role-self-update" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.updateUserRole(admin, vet.id, { role: "VIEWER", departmentCode: "INPATIENT", reason: "Sem versão", confirm: true, idempotencyKey: "role-missing-version" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.updateUserRole(admin, vet.id, { role: "VIEWER", departmentCode: "INPATIENT", expectedVersion: 2, idempotencyKey: "role-without-reason" })).resolves.toMatchObject({ id: vet.id, role: "VIEWER", version: 3 });
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "UserRoleUpdated", actorId: admin.id, entityId: vet.id, previousState: "MANAGER:INPATIENT:true", newState: "VIEWER:INPATIENT:true", metadata: { action: "UPDATE_USER_ACCESS", departmentCode: "INPATIENT" } });
    const beforeAdminGrant = store.getState();
    await expect(service.updateUserRole(admin, vet.id, { role: "ADMIN", departmentCode: "INPATIENT", expectedVersion: 3, idempotencyKey: "role-admin-without-stepup" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    expect(store.getState()).toEqual(beforeAdminGrant);
  });

  it("rejects invalid pagination at the application boundary", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const manager = store.getState().users.find((user) => user.email === "manager@cvg.local");
    if (!manager) throw new Error("fixture actor missing");

    await expect(service.getPatientDiagnostics(manager, "patient-thor", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listAuditEvents(manager, { limit: 101 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listRequests(manager, { status: "NOT_A_STATUS" as never })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listRequests(manager, { priority: "NOT_A_PRIORITY" as never })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("applies request list filters before cursor pagination", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!vet) throw new Error("fixture actor missing");

    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "EMERGENCY",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "read-filter-request" });
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const filtered = await service.listRequests(vet, {
      priority: "EMERGENCY",
      serviceId: "service-hemogram",
      overdue: false,
      from,
      to,
      limit: 1
    });
    expect(filtered.items.map((entry) => entry.id)).toEqual([request.id]);
    expect(filtered.total).toBe(1);
    expect((await service.listRequests(vet, { serviceId: "service-does-not-exist" })).items).toEqual([]);
    await expect(service.listRequests(vet, { from: to, to: from })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listRequests(vet, { from: "not-a-date" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("searches authorized tutor, sector and professional fields with stable cursors", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!vet) throw new Error("fixture actor missing");

    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "URGENT",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "search-fields-request" });
    await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-xray" }]
    }, { idempotencyKey: "search-fields-request-2" });

    expect((await service.search(vet, "Oliveira")).items.map((entry) => entry.id)).toContain(request.id);
    expect((await service.search(vet, "LABORATORY", { types: ["ITEM"] })).items[0]).toMatchObject({ type: "ITEM", deepLink: expect.stringContaining(`/requests/${request.id}#`) });
    expect((await service.search(vet, "vet@cvg.local")).items.map((entry) => entry.id)).toContain(request.id);

    const firstPage = await service.search(vet, "thor", { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await service.search(vet, "thor", { limit: 1, cursor: firstPage.nextCursor });
    expect(secondPage.items.every((entry) => entry.id !== firstPage.items[0].id)).toBe(true);
    const stableFirstPage = await service.search(vet, "thor", { limit: 1 });
    const stableFirstId = stableFirstPage.items[0].id;
    await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-ultrasound" }]
    }, { idempotencyKey: "search-stable-insert" });
    const stableSecondPage = await service.search(vet, "thor", { limit: 1, cursor: stableFirstPage.nextCursor });
    expect(stableSecondPage.items[0]?.id).not.toBe(stableFirstId);
    await expect(service.search(vet, "thor", { status: "NOT_A_STATUS" as never })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
