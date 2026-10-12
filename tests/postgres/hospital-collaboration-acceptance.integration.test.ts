import { afterEach, describe, expect, it, vi } from "vitest";
import type { HospitalDocumentContent } from "../../packages/contracts/src/index";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { eventVisible } from "../../src/server/application/realtime-visibility";
import { InProcessEventBus, processOutboxBatch } from "../../src/server/operations/outbox";

const rich = (text: string): HospitalDocumentContent => ({ type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text }] }] });
function collaborationState() {
  const state = createDemoState("hospital-collaboration-acceptance-postgres-fixture");
  const vet = state.users.find(user => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "pg-contributor", email: "pg-contributor@example.test", displayName: "Contribuidor exclusivamente sintético" });
  state.departments = state.departments.map(department => department.code === "INPATIENT" ? { ...department, memberUserIds: [...department.memberUserIds, "pg-contributor"] } : department);
  return state;
}

describe("collaboration acceptance through native commands on disposable PostgreSQL", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps two contributors' versioned edits, actual task snapshots and approval history through publication, retirement, archive and current revocation", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = collaborationState(); const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first), b = createApplicationService(second);
        const admin = base.users.find(user => user.id === "user-admin")!;
        const author = base.users.find(user => user.id === "user-vet")!;
        const contributor = base.users.find(user => user.id === "pg-contributor")!;
        const baseline = base.accessGroups.find(group => group.id === contributor.accessGroupId)!;
        const group = await a.createAccessGroup(admin, { code: "PG_DOCUMENT_CONTRIBUTOR", description: "Grupo sintético de coedição", permissions: baseline.permissions, idempotencyKey: "document-contributor-group" });
        await a.assignUserAccessGroup(admin, contributor.id, { accessGroupId: group.id, expectedGroupVersion: group.version, expectedVersion: contributor.version, idempotencyKey: "document-contributor-binding" });
        const created = await a.createHospitalDocument(admin, { code: "PG_ACCEPTANCE_DOCUMENT", title: "Documento exclusivamente sintético", departmentCode: "INPATIENT", responsibleUserId: author.id, content: rich("Instrução inicial sintética"), idempotencyKey: "document-create" });
        const documentId = created.document.id;
        const firstEdit = await a.updateHospitalDocumentDraft(author, documentId, { expectedVersion: 1, expectedDraftVersion: 1, content: rich("Contribuição A"), idempotencyKey: "document-author-edit" });
        await expect(b.updateHospitalDocumentDraft(contributor, documentId, { expectedVersion: 1, expectedDraftVersion: 1, content: rich("Texto obsoleto B"), idempotencyKey: "document-stale-edit" })).rejects.toMatchObject({ code: "STALE_VERSION" });
        expect((await b.getHospitalDocument(contributor, documentId)).document).toEqual(firstEdit.document);
        const edit = { expectedVersion: firstEdit.document.version, expectedDraftVersion: firstEdit.document.revisions[0].version, content: rich("Contribuição A\nContribuição B revisada"), idempotencyKey: "document-contributor-edit" };
        const combined = await b.updateHospitalDocumentDraft(contributor, documentId, edit);
        expect(combined.document.revisions[0]).toMatchObject({ createdBy: admin.id, updatedBy: contributor.id, content: edit.content });
        const unsafe = { type: "hospital-document" as const, version: 1 as const, blocks: [{ type: "paragraph" as const, content: [{ text: "Link inválido", href: "javascript:alert(1)" }] }] };
        await expect(a.updateHospitalDocumentDraft(author, documentId, { expectedVersion: combined.document.version, expectedDraftVersion: combined.document.revisions[0].version, content: unsafe, idempotencyKey: "document-unsafe-edit" })).rejects.toMatchObject({ status: 400 });
        expect((await a.getHospitalDocument(author, documentId)).document).toEqual(combined.document);
        const publicationInput = { confirm: true as const, expectedVersion: combined.document.version, expectedDraftVersion: combined.document.revisions[0].version };
        const publishers = await Promise.allSettled([
          a.approveHospitalDocument(author, documentId, { ...publicationInput, policyReference: "SYNTHETIC_APPROVAL_A_NOT_INSTITUTIONAL", idempotencyKey: "document-publish-a" }),
          b.approveHospitalDocument(contributor, documentId, { ...publicationInput, policyReference: "SYNTHETIC_APPROVAL_B_NOT_INSTITUTIONAL", idempotencyKey: "document-publish-b" })
        ]);
        expect(publishers.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(publishers.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
        const winner = publishers.find(result => result.status === "fulfilled");
        if (!winner || winner.status !== "fulfilled") throw new Error("No synthetic publication winner");
        const publication = winner.value; const original = publication.document.revisions[0];
        expect(original).toMatchObject({ status: "APPROVED", content: edit.content });
        expect([author.id, contributor.id]).toContain(original.approvedBy); expect(original.approvedAt).toBeDefined();
        const task = await a.createHospitalTask(author, { title: "Tarefa usando publicação anterior", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", documentIds: [documentId], priority: "ROUTINE", idempotencyKey: "document-actual-task" });
        const frozen = structuredClone(task.task.documentSnapshots);
        expect(frozen).toEqual([expect.objectContaining({ documentId, revisionId: original.id, revision: 1, content: original.content, approvedBy: original.approvedBy, approvedAt: original.approvedAt, policyReference: original.policyReference })]);
        await expect(b.updateHospitalDocumentDraft(contributor, documentId, { expectedVersion: publication.document.version, expectedDraftVersion: original.version, content: rich("Sobrescrita negada"), idempotencyKey: "document-approved-overwrite" })).rejects.toMatchObject({ code: "DOCUMENT_DRAFT_REQUIRED" });
        const revision = await a.createHospitalDocumentRevision(admin, documentId, { expectedVersion: publication.document.version, content: rich("Instrução futura sintética"), idempotencyKey: "document-new-revision" });
        const next = await b.approveHospitalDocument(author, documentId, { expectedVersion: revision.document.version, expectedDraftVersion: 1, confirm: true, policyReference: "SYNTHETIC_APPROVAL_2_NOT_INSTITUTIONAL", idempotencyKey: "document-next-publication" });
        const retired = await a.retireHospitalDocument(admin, documentId, { expectedVersion: next.document.version, expectedRevisionId: next.document.currentPublishedRevisionId!, reason: "Retirada exclusivamente sintética", idempotencyKey: "document-retire" });
        expect(retired.document.revisions.map(entry => entry.status)).toEqual(["RETIRED", "RETIRED"]);
        expect(retired.document.revisions[0]).toMatchObject({ id: original.id, content: original.content, approvedBy: original.approvedBy, approvedAt: original.approvedAt, policyReference: original.policyReference });
        await expect(b.createHospitalTask(author, { title: "Novo vínculo negado", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", documentIds: [documentId], priority: "ROUTINE", idempotencyKey: "document-retired-new-link" })).rejects.toMatchObject({ code: "DOCUMENT_NOT_APPROVED" });
        const archived = await a.archiveHospitalDocument(admin, documentId, { archived: true, expectedVersion: retired.document.version, reason: "Arquivo exclusivamente sintético", idempotencyKey: "document-archive" });
        expect((await b.listHospitalDocuments(author)).total).toBe(0);
        expect((await b.listHospitalDocuments(author, { includeArchived: true })).items.map(document => document.id)).toEqual([documentId]);
        expect(await b.getHospitalDocumentHistory(author, documentId)).toEqual(archived.document.revisions);
        const copy = await a.duplicateHospitalDocument(admin, documentId, { code: "PG_ACCEPTANCE_COPY", title: "Cópia independente sintética", responsibleUserId: author.id, expectedVersion: archived.document.version, idempotencyKey: "document-duplicate" });
        expect(copy.document.id).not.toBe(documentId); expect(copy.document).toMatchObject({ sourceDocumentId: documentId, sourceRevisionId: next.document.currentPublishedRevisionId });
        expect(copy.document.currentPublishedRevisionId).toBeUndefined(); expect(copy.document.revisions[0].status).toBe("DRAFT"); expect(copy.document.revisions[0].approvedBy).toBeUndefined();
        expect((await b.getHospitalDocument(author, documentId)).document).toEqual(archived.document);
        expect((await b.getHospitalTask(author, task.task.id)).task.documentSnapshots).toEqual(frozen);
        const audit = await second.readAuditEvents({ scope: { entities: [{ entityType: "HospitalDocument", entityId: documentId }] }, order: "asc", limit: 100 });
        expect(new Set(audit.items.filter(event => event.eventType === "HospitalDocumentDraftUpdated").map(event => event.actorId))).toEqual(new Set([author.id, contributor.id]));
        expect(audit.items.filter(event => event.eventType === "HospitalDocumentApproved")).toHaveLength(2);
        expect(JSON.stringify(audit.items)).not.toContain("Contribuição A");

        await a.updateAccessGroup(admin, group.id, { permissions: group.permissions.filter(permission => permission !== "hospital_document.view" && permission !== "hospital_document.update"), expectedVersion: group.version, idempotencyKey: "document-contributor-revocation" });
        await expect(b.getHospitalDocument(contributor, documentId)).rejects.toMatchObject({ status: 404 });
        await expect(b.getHospitalDocumentHistory(contributor, documentId)).rejects.toMatchObject({ status: 404 });
        await expect(b.updateHospitalDocumentDraft(contributor, documentId, edit)).rejects.toMatchObject({ status: 404 });
        const after = await second.readState();
        expect(eventVisible(after, contributor, "HospitalDocument", documentId, {})).toBe(false);
        expect(eventVisible(after, author, "HospitalDocument", documentId, {})).toBe(true);
        expect((await b.getHospitalTask(contributor, task.task.id)).task.documentSnapshots).toEqual([]);
        expect(after.hospitalTasks.find(entry => entry.id === task.task.id)?.documentSnapshots).toEqual(frozen);
        expect(after.patientGrants).toEqual(base.patientGrants);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("keeps actual handoff and critical obligations pending across convenience read, read-all, mute and archive, then hides revoked targets", async () => {
    vi.stubEnv("CRITICAL_POLICY_ENABLED", "true"); vi.stubEnv("CRITICAL_POLICY_VERSION", "SYNTHETIC_COLLABORATION_ACCEPTANCE_ONLY"); vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", "test-only-not-institutional-approval"); vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", "2026-01-01T00:00:00.000Z");
    await withDisposablePostgresDatabase(async (database) => {
      const base = collaborationState(); const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first), b = createApplicationService(second);
        const admin = base.users.find(user => user.id === "user-admin")!; const vet = base.users.find(user => user.id === "user-vet")!;
        const recipient = base.users.find(user => user.id === "pg-contributor")!; const manager = base.users.find(user => user.id === "user-manager")!; const lab = base.users.find(user => user.id === "user-lab")!;
        const baseline = base.accessGroups.find(group => group.id === recipient.accessGroupId)!;
        const group = await a.createAccessGroup(admin, { code: "PG_OBLIGATION_RECIPIENT", description: "Grupo sintético de destinatário", permissions: baseline.permissions, idempotencyKey: "obligation-group" });
        await a.assignUserAccessGroup(admin, recipient.id, { accessGroupId: group.id, expectedGroupVersion: group.version, expectedVersion: recipient.version, idempotencyKey: "obligation-group-binding" });
        const at = Date.now(); const iso = (offset: number) => new Date(at + offset).toISOString();
        const from = await a.createHospitalShift(manager, { name: "Origem sintética", departmentCode: "INPATIENT", startAt: iso(-3_600_000), endAt: iso(3_600_000), members: [{ userId: vet.id }], idempotencyKey: "obligation-source-shift" });
        const to = await a.createHospitalShift(manager, { name: "Destino sintético", departmentCode: "INPATIENT", startAt: iso(-60_000), endAt: iso(21_600_000), members: [{ userId: recipient.id }], idempotencyKey: "obligation-destination-shift" });
        const task = await a.createHospitalTask(vet, { title: "Pendência assistencial sintética", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: vet.id, priority: "URGENT", plannedEndAt: iso(7_200_000), idempotencyKey: "obligation-care-task" });
        const assigned = await a.assignHospitalActivityShift(manager, { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.shift.id, expectedVersion: task.task.version, idempotencyKey: "obligation-shift-binding" });
        const handoff = await a.offerHospitalHandoff(vet, { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: recipient.id, entries: [{ targetType: "HOSPITAL_TASK", targetId: task.task.id, expectedTargetVersion: assigned.version }], idempotencyKey: "obligation-offer" });
        await a.createHospitalTaskComment(vet, task.task.id, { body: "Comentário de conveniência sintético", mentionedUserIds: [recipient.id], expectedVersion: assigned.version, idempotencyKey: "obligation-convenience-mention" });
        const request = await b.createRequest(recipient, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "obligation-critical-request" });
        const received = await a.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "obligation-critical-sample" });
        const started = await a.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "obligation-critical-process" });
        const draft = await a.createResultDraft(lab, request.items[0].id, { narrative: "Synthetic channel regression; no institutional clinical interpretation.", content: {}, expectedVersion: started.item.version, idempotencyKey: "obligation-critical-draft" });
        const released = await a.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "obligation-critical-release" });
        // Explicit test-only in-process transport; no real recipient is contacted.
        await processOutboxBatch(first, new InProcessEventBus(), { batchSize: 100, allowSyntheticDelivery: true });
        const before = await second.readState();
        const critical = before.notifications.find(entry => entry.recipientUserId === recipient.id && entry.entityId === released.version.id && entry.category === "CRITICAL")!;
        expect(critical).toMatchObject({ state: "DELIVERED" });
        const obligations = (state: typeof before) => ({ tasks: state.hospitalTasks, handoffs: state.hospitalHandoffs, critical: state.notifications });
        const immutable = structuredClone(obligations(before));
        const criticalCount = async () => (await b.dashboard(recipient)).indicators.find(indicator => indicator.key === "critical")!.count;
        const initialInbox = await b.listWorkNotifications(recipient);
        expect(initialInbox.total).toBe(2); expect(initialInbox.unread).toBe(2);
        expect(initialInbox.items.map(entry => entry.notification.eventType).sort()).toEqual(["HANDOFF_OFFERED", "TASK_MENTIONED"]);
        expect(await criticalCount()).toBe(1);
        const notice = initialInbox.items.find(entry => entry.notification.eventType === "HANDOFF_OFFERED")!;
        await b.markWorkNotificationsRead(recipient, { notificationIds: [notice.notification.id], idempotencyKey: "obligation-personal-read" });
        expect((await b.listWorkNotifications(recipient, { unreadOnly: true })).total).toBe(1);
        expect((await b.listWorkNotifications(recipient)).unread).toBe(1);
        await b.markWorkNotificationsRead(recipient, { all: true, idempotencyKey: "obligation-personal-read-all" });
        expect((await b.listWorkNotifications(recipient)).unread).toBe(0);
        expect((await b.listWorkNotifications(recipient, { unreadOnly: true })).items).toEqual([]);
        await b.putWorkNotificationPreferences(recipient, { mutedEvents: ["HANDOFF_OFFERED", "TASK_MENTIONED"], expectedVersion: 0, idempotencyKey: "obligation-personal-mute" });
        expect((await a.getWorkNotificationPreferences(vet)).mutedEvents).toEqual([]);
        await a.createHospitalTaskComment(vet, task.task.id, { body: "Nova menção pessoal silenciada", mentionedUserIds: [recipient.id], expectedVersion: assigned.version, idempotencyKey: "obligation-muted-mention" });
        expect((await b.listWorkNotifications(recipient)).total).toBe(2);
        const readNotice = (await b.listWorkNotifications(recipient)).items.find(entry => entry.notification.id === notice.notification.id)!;
        const archived = await b.setWorkNotificationArchived(recipient, notice.notification.id, { archived: true, expectedVersion: readNotice.notification.version, idempotencyKey: "obligation-personal-archive" });
        expect((await b.listWorkNotifications(recipient)).total).toBe(1);
        expect((await b.listWorkNotifications(recipient, { includeArchived: true })).total).toBe(2);
        expect((await b.listHospitalHandoffs(recipient, { state: "OFFERED" })).items.map(entry => entry.handoff.id)).toEqual([handoff.handoff.id]);
        expect((await b.listNotifications(recipient, "CRITICAL")).items).toContainEqual(expect.objectContaining({ id: critical.id, state: "DELIVERED" }));
        expect(await criticalCount()).toBe(1);
        expect(obligations(await second.readState())).toEqual(immutable);
        await expect(b.setWorkNotificationArchived(recipient, critical.id, { archived: true, expectedVersion: critical.version, idempotencyKey: "obligation-denied-critical-archive" })).rejects.toMatchObject({ status: 404 });

        await a.updateAccessGroup(admin, group.id, { permissions: group.permissions.filter(permission => permission !== "shift.view" && permission !== "hospital_task.view"), expectedVersion: group.version, idempotencyKey: "obligation-target-revocation" });
        const revoked = await b.listWorkNotifications(recipient, { includeArchived: true });
        expect(revoked).toMatchObject({ total: 0, unread: 0, items: [] });
        await expect(b.setWorkNotificationArchived(recipient, notice.notification.id, { archived: false, expectedVersion: archived.notification.version, idempotencyKey: "obligation-denied-restoration" })).rejects.toMatchObject({ status: 404 });
        const after = await second.readState();
        expect(after.hospitalHandoffs.find(entry => entry.id === handoff.handoff.id)?.state).toBe("OFFERED");
        expect(after.hospitalTasks.find(entry => entry.id === task.task.id)).toMatchObject({ responsibleUserId: vet.id, phase: "PENDING", plannedEndAt: task.task.plannedEndAt });
        expect(after.notifications.find(entry => entry.id === critical.id)?.state).toBe("DELIVERED");
        expect(await criticalCount()).toBe(1);
        expect(after.patientGrants).toEqual(base.patientGrants);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
