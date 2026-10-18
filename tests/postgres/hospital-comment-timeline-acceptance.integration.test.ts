import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { createHospitalTaskAttachmentService } from "../../src/server/application/hospital-task-attachment-service";
import type { FileStore } from "../../src/server/storage/file-store";

describe("BLD-HPL-037/047 composed native acceptance on disposable PostgreSQL", () => {
  it("persists two professionals' conversation, arbitrates edits and resumes the same failed file session without exposing unfinished or quarantined bytes", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-comment-upload-acceptance");
      const author = base.users.find(user => user.id === "user-vet")!;
      const contributor = { ...author, id: "pg-comment-colleague", email: "pg-comment-colleague@example.test", displayName: "Colega exclusivamente sintético" };
      base.users.push(contributor);
      base.departments = base.departments.map(department => department.code === "INPATIENT" ? { ...department, memberUserIds: [...department.memberUserIds, contributor.id] } : department);
      const first = await database.createStore(base), second = await database.createStore();
      const files = new Map<string, Buffer>(); let unavailable = true;
      const storage: FileStore = {
        put: async (key, content) => { if (unavailable) { unavailable = false; throw new Error("synthetic storage outage"); } files.set(key, Buffer.from(content)); },
        get: async key => { const content = files.get(key); if (!content) throw new Error("synthetic missing file"); return content; },
        remove: async key => { files.delete(key); }, exists: async key => files.has(key)
      };
      const service = (store: typeof first) => ({ ...createApplicationService(store, { storage }), ...createHospitalTaskAttachmentService({ store, storage, scanner: { scan: async () => "CLEAN" }, patientDiagnosticsAuxiliaryReader: () => ({ samples: [], results: [], attachments: [] }) }) });
      try {
        const a = service(first), b = service(second), admin = base.users.find(user => user.id === "user-admin")!;
        const baseline = base.accessGroups.find(group => group.id === contributor.accessGroupId)!;
        const group = await a.createAccessGroup(admin, { code: "PG_COMMENT_COLLEAGUE", description: "Grupo exclusivamente sintético", permissions: baseline.permissions, idempotencyKey: "comment-group" });
        await a.assignUserAccessGroup(admin, contributor.id, { accessGroupId: group.id, expectedGroupVersion: group.version, expectedVersion: contributor.version, idempotencyKey: "comment-group-binding" });
        const task = await a.createHospitalTask(author, { title: "Conversa e evidência sintéticas", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: author.id, priority: "ROUTINE", idempotencyKey: "comment-task" });
        const opened = await a.createHospitalTaskComment(author, task.task.id, { body: "Profissional A: verificar evidência sintética", mentionedUserIds: [contributor.id], expectedVersion: task.task.version, idempotencyKey: "comment-a" });
        const colleagueRead = (await b.listHospitalTaskComments(contributor, task.task.id)).items;
        expect(colleagueRead.map(entry => entry.comment)).toEqual([opened.comment]);
        expect(colleagueRead[0].permissions).not.toContain("hospital_task.comment.edit_own");
        const reply = await b.createHospitalTaskComment(contributor, task.task.id, { body: "Profissional B: evidência recebida para revisão", mentionedUserIds: [author.id], expectedVersion: task.task.version, idempotencyKey: "comment-b" });
        const conversation = await a.listHospitalTaskComments(author, task.task.id);
        expect(new Map(conversation.items.map(entry => [entry.comment.id, { author: entry.author.id, body: entry.comment.body }]))).toEqual(new Map([[opened.comment.id, { author: author.id, body: opened.comment.body }], [reply.comment.id, { author: contributor.id, body: reply.comment.body }]]));
        const beforeDeniedMention = await second.readState();
        await expect(a.createHospitalTaskComment(author, task.task.id, { body: "Menção não autorizada", mentionedUserIds: ["user-lab"], expectedVersion: task.task.version, idempotencyKey: "comment-outside" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
        expect(await second.readState()).toEqual(beforeDeniedMention);
        const edits = await Promise.allSettled([
          a.updateHospitalTaskComment(author, task.task.id, opened.comment.id, { body: "Revisão sintética A1", expectedVersion: 1, idempotencyKey: "comment-edit-one" }),
          b.updateHospitalTaskComment(author, task.task.id, opened.comment.id, { body: "Revisão sintética A2", expectedVersion: 1, idempotencyKey: "comment-edit-two" })
        ]);
        expect(edits.filter(edit => edit.status === "fulfilled")).toHaveLength(1);
        expect(edits.find(edit => edit.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION", status: 409 } });
        const edited = (await b.listHospitalTaskComments(contributor, task.task.id)).items.find(entry => entry.comment.id === opened.comment.id)!;
        expect(edited.comment).toMatchObject({ version: 2, authorId: author.id, revisions: [{ version: 1, body: opened.comment.body, editedBy: author.id }] });
        expect(["Revisão sintética A1", "Revisão sintética A2"]).toContain(edited.comment.body);

        const bytes = Buffer.from("%PDF-1.7\nOnly synthetic upload acceptance evidence\n");
        const input = { filename: "evidence.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expectedVersion: task.task.version, idempotencyKey: "same-file-session" };
        const prepared = await a.createHospitalTaskAttachmentSession(author, task.task.id, input);
        await expect(a.uploadHospitalTaskAttachment(author, prepared.attachment.id, bytes)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503, details: { retryable: true } });
        const failed = (await second.readState()).hospitalTaskAttachments;
        expect(failed).toHaveLength(1); expect(failed[0]).toMatchObject({ id: prepared.attachment.id, uploadStatus: "INITIATED", scanStatus: "PENDING", version: 1 });
        expect(failed[0].uploadClaimToken).toBeUndefined(); expect(files.size).toBe(0);
        expect((await b.listHospitalTaskAttachments(contributor, task.task.id)).items).toEqual([]);
        await expect(b.downloadHospitalTaskAttachment(contributor, prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
        expect((await b.createHospitalTaskAttachmentSession(author, task.task.id, input)).attachment.id).toBe(prepared.attachment.id);
        const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
        await expect(b.uploadHospitalTaskAttachment(author, prepared.attachment.id, corrupted)).rejects.toMatchObject({ code: "ATTACHMENT_CHECKSUM_MISMATCH", status: 400 });
        expect(files.size).toBe(0);
        const uploaded = await b.uploadHospitalTaskAttachment(author, prepared.attachment.id, bytes);
        expect(uploaded.attachment).toMatchObject({ id: prepared.attachment.id, uploadStatus: "UPLOADED", scanStatus: "CLEAN", version: 2 });
        await expect(b.downloadHospitalTaskAttachment(contributor, prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
        const finalize = { expectedVersion: 2, idempotencyKey: "same-file-finalize" };
        const final = await a.finalizeHospitalTaskAttachment(author, prepared.attachment.id, finalize);
        expect(await b.finalizeHospitalTaskAttachment(author, prepared.attachment.id, finalize)).toEqual(final);
        expect((await b.downloadHospitalTaskAttachment(contributor, prepared.attachment.id)).content).toEqual(bytes);
        expect(files.size).toBe(1);
        const wrongMime = await a.createHospitalTaskAttachmentSession(author, task.task.id, { ...input, filename: "wrong.png", mimeType: "image/png", idempotencyKey: "wrong-mime-session" });
        expect((await b.uploadHospitalTaskAttachment(author, wrongMime.attachment.id, bytes)).attachment.scanStatus).toBe("QUARANTINED");
        await expect(a.finalizeHospitalTaskAttachment(author, wrongMime.attachment.id, { expectedVersion: 2, idempotencyKey: "quarantined-finalize" })).rejects.toMatchObject({ code: "ATTACHMENT_QUARANTINED", status: 422 });
        await expect(b.downloadHospitalTaskAttachment(contributor, wrongMime.attachment.id)).rejects.toMatchObject({ status: 404 });
        expect((await b.listHospitalTaskAttachments(contributor, task.task.id)).items.map(file => file.id)).toEqual([prepared.attachment.id]);
        const audit = await second.readAuditEvents({ scope: { entities: [{ entityType: "HospitalTaskAttachment", entityId: prepared.attachment.id }] }, order: "asc", limit: 100 });
        expect(audit.items.filter(event => event.eventType === "HospitalTaskAttachmentFinalized")).toHaveLength(1);
        expect(JSON.stringify(audit.items)).not.toContain(bytes.toString());
        const beforeRevocation = await second.readState();
        await a.updateAccessGroup(admin, group.id, { permissions: group.permissions.filter(permission => !permission.startsWith("hospital_task.comment.") && !permission.startsWith("hospital_task.attachment.")), expectedVersion: group.version, idempotencyKey: "comment-access-revoked" });
        await expect(b.listHospitalTaskComments(contributor, task.task.id)).rejects.toMatchObject({ status: 404 });
        await expect(b.createHospitalTaskComment(contributor, task.task.id, { body: reply.comment.body, mentionedUserIds: [author.id], expectedVersion: task.task.version, idempotencyKey: "comment-b" })).rejects.toMatchObject({ status: 404 });
        await expect(b.downloadHospitalTaskAttachment(contributor, prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
        const after = await second.readState();
        expect(after.hospitalTaskComments).toEqual(beforeRevocation.hospitalTaskComments); expect(after.hospitalTaskAttachments).toEqual(beforeRevocation.hospitalTaskAttachments);
        for (const collection of ["hospitalTasks", "patientGrants", "items", "results", "resultVersions", "schedules"] as const) expect(after[collection]).toEqual(beforeRevocation[collection]);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try { const restored = service(reopened); expect((await restored.listHospitalTaskComments(author, task.task.id)).items).toHaveLength(2); expect((await restored.downloadHospitalTaskAttachment(author, prepared.attachment.id)).content).toEqual(bytes); await expect(restored.downloadHospitalTaskAttachment(contributor, prepared.attachment.id)).rejects.toMatchObject({ status: 404 }); } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("arbitrates planned-cell edits while preserving real reservations, pending prerequisites, diagnostic locks and read-only authority", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-timeline-native-acceptance");
      const first = await database.createStore(base), second = await database.createStore();
      try {
        const a = createApplicationService(first), b = createApplicationService(second);
        const admin = base.users.find(user => user.id === "user-admin")!, manager = base.users.find(user => user.id === "user-manager")!, vet = base.users.find(user => user.id === "user-vet")!;
        const create = (key: string) => a.createHospitalTask(manager, { title: key, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: manager.id, priority: "ROUTINE", idempotencyKey: key });
        const source = await create("timeline-prerequisite"), target = await create("timeline-target"), competing = await create("timeline-competing");
        const request = await a.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "timeline-real-diagnostic" });
        const linked = await a.putHospitalTaskDependency(manager, target.task.id, { targetType: "HOSPITAL_TASK", targetId: source.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "timeline-pending-link" });
        const clinical = await a.putHospitalTaskDependency(manager, target.task.id, { targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, blocks: "COMPLETE", active: true, expectedVersion: linked.task.version, idempotencyKey: "timeline-clinical-link" });
        const startsAt = new Date(Date.now() - 60_000).toISOString(), endsAt = new Date(Date.now() + 3_600_000).toISOString();
        const resource = await a.createHospitalResource(admin, { code: "PG_TIMELINE_ROOM", name: "Sala exclusivamente sintética", kind: "ROOM", departmentCode: "INPATIENT", availabilityWindows: [{ startsAt, endsAt }], idempotencyKey: "timeline-room" });
        const reservation = await a.reserveHospitalTaskSchedule(manager, target.task.id, { startsAt, endsAt, resourceIds: [resource.id], expectedVersion: clinical.task.version, idempotencyKey: "timeline-real-reservation" });
        const before = await second.readState();
        const plannedStartAt = new Date(Date.now() + 7_200_000).toISOString(), plannedEndAt = new Date(Date.now() + 10_800_000).toISOString();
        const edits = await Promise.allSettled([
          a.updateHospitalTask(manager, target.task.id, { title: "Planejamento versão A", plannedStartAt, plannedEndAt, expectedVersion: clinical.task.version, idempotencyKey: "timeline-edit-a" }),
          b.updateHospitalTask(manager, target.task.id, { title: "Planejamento versão B", plannedStartAt, plannedEndAt, expectedVersion: clinical.task.version, idempotencyKey: "timeline-edit-b" })
        ]);
        expect(edits.filter(edit => edit.status === "fulfilled")).toHaveLength(1);
        expect(edits.find(edit => edit.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION", status: 409 } });
        const planned = await b.getHospitalTask(manager, target.task.id);
        expect(planned.task).toMatchObject({ plannedStartAt, plannedEndAt, version: clinical.task.version + 1, phase: "PENDING" });
        expect(planned.reservations).toEqual([reservation]); expect(planned.dependencies).toEqual(clinical.dependencies);
        expect((await second.readState()).schedules).toEqual(before.schedules);
        const blocked = await second.readState();
        await expect(b.reserveHospitalTaskSchedule(manager, competing.task.id, { startsAt, endsAt, resourceIds: [resource.id], expectedVersion: competing.task.version, idempotencyKey: "timeline-overlap" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT", status: 409 });
        await expect(b.commandHospitalTask(manager, target.task.id, { command: "START", expectedVersion: planned.task.version, idempotencyKey: "timeline-blocked-start" })).rejects.toMatchObject({ code: "TASK_DEPENDENCY_PENDING", status: 409 });
        expect(await second.readState()).toEqual(blocked);
        const prerequisite = await a.commandHospitalTask(manager, source.task.id, { command: "START", expectedVersion: source.task.version, idempotencyKey: "timeline-prerequisite-start" });
        await a.commandHospitalTask(manager, source.task.id, { command: "COMPLETE", expectedVersion: prerequisite.task.version, idempotencyKey: "timeline-prerequisite-complete" });
        const started = await b.commandHospitalTask(manager, target.task.id, { command: "START", expectedVersion: planned.task.version, idempotencyKey: "timeline-unblocked-start" });
        const beforeClinicalGuard = await second.readState();
        await expect(a.commandHospitalTask(manager, target.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "timeline-clinically-blocked" })).rejects.toMatchObject({ code: "TASK_DEPENDENCY_PENDING", status: 409 });
        expect(await second.readState()).toEqual(beforeClinicalGuard);
        const readGroup = await a.createAccessGroup(admin, { code: "PG_TIMELINE_READ_ONLY", description: "Leitura exclusivamente sintética", permissions: ["hospital_task.view", "hospital_calendar.view", "hospital_resource.view"], idempotencyKey: "timeline-read-group" });
        await a.assignUserAccessGroup(admin, manager.id, { accessGroupId: readGroup.id, expectedGroupVersion: readGroup.version, expectedVersion: manager.version, idempotencyKey: "timeline-read-binding" });
        const reading = await b.getHospitalTask(manager, target.task.id);
        expect(reading.task).toEqual(started.task); expect(reading.permissions).not.toContain("hospital_task.update"); expect(reading.permissions).not.toContain("hospital_task.execute"); expect(reading.permissions).not.toContain("hospital_calendar.cancel");
        expect(reading.reservations).toEqual([reservation]);
        const readState = await second.readState();
        await expect(b.updateHospitalTask(manager, target.task.id, { title: "Mudança não autorizada", expectedVersion: started.task.version, idempotencyKey: "timeline-read-edit" })).rejects.toMatchObject({ status: 404 });
        await expect(b.commandHospitalTask(manager, target.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "timeline-read-complete" })).rejects.toMatchObject({ status: 404 });
        await expect(b.cancelHospitalTaskSchedule(manager, reservation.id, { reason: "Sem autorização", expectedVersion: reservation.version, idempotencyKey: "timeline-read-cancel" })).rejects.toMatchObject({ status: 404 });
        expect(await second.readState()).toEqual(readState);
        for (const collection of ["items", "samples", "procedures", "results", "resultVersions", "patientGrants"] as const) expect(readState[collection]).toEqual(before[collection]);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try { const final = createApplicationService(reopened); expect((await final.getHospitalTask(manager, target.task.id)).task).toEqual(started.task); expect((await reopened.readState()).schedules).toEqual(before.schedules); } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
