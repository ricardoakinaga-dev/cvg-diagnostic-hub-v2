import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalPlannerHttpFixture as fixture } from "@/test/hospital-planner-http-fixture";
import { rich } from "@/test/hospital-external-fixtures";
import { HOSPITAL_SERVICE_COLUMNS } from "../application/hospital-service-import";
import { resetRateLimits } from "../security/rate-limit";

const version = (value: number) => ({ "if-match": `"${value}"` });
const documentInput = { code: "HTTP_PROTOCOL", title: "Protocolo sintético", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Conteúdo sintético inicial") };

describe.sequential("collaboration commands preserve source ownership and publication history", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });

  it("edits, locks and explicitly publishes a structured document under both concurrency versions", async () => {
    const c = await fixture(); expect((await c.send("user-admin", "GET", "hospital-documents/options")).status).toBe(200);
    const created = await c.send("user-admin", "POST", "hospital-documents", documentInput); expect(created.status).toBe(201); const id = created.envelope.data.document.id;
    expect((await c.send("user-vet", "GET", `hospital-documents/${id}`)).envelope.data.document.code).toBe(documentInput.code);
    const metadata = await c.send("user-admin", "PATCH", `hospital-documents/${id}/metadata`, { responsibleUserId: "vet-b" }, version(1)); expect(metadata.status).toBe(200);
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/lock`, { locked: true, reason: "Pausa sintética de edição" }, version(2))).status).toBe(200);
    expect((await c.send("user-admin", "PATCH", `hospital-documents/${id}/draft`, { expectedDraftVersion: 1, title: "Edição bloqueada" }, version(3))).status).toBe(409);
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/lock`, { locked: false, reason: "Retomar edição sintética" }, version(3))).status).toBe(200);
    const edited = await c.send("user-admin", "PATCH", `hospital-documents/${id}/draft`, { expectedDraftVersion: 1, title: "Protocolo sintético revisado", content: rich("Conteúdo sintético revisado") }, version(4)); expect(edited.status).toBe(200);
    const before = structuredClone(c.store.getState().hospitalDocuments);
    expect((await c.send("user-admin", "PATCH", `hospital-documents/${id}/draft`, { expectedDraftVersion: 1, title: "Editor concorrente obsoleto" }, version(5))).status).toBe(409); expect(c.store.getState().hospitalDocuments).toEqual(before);
    const approval = { expectedDraftVersion: 2, confirm: true, policyReference: "SYNTHETIC_HTTP_TEST_ONLY_NOT_CLINICAL_HOMOLOGATION" };
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/approve`, approval, version(5))).status).toBe(404);
    const approved = await c.send("user-vet", "POST", `hospital-documents/${id}/approve`, approval, version(5)); expect(approved.status).toBe(200); expect(approved.envelope.data.document.revisions[0]).toMatchObject({ status: "APPROVED", approvedBy: "user-vet" });
    const history = await c.send("user-vet", "GET", `hospital-documents/${id}/history`); expect(history.status).toBe(200);
    expect((await c.send("user-vet", "GET", "hospital-documents?departmentCode=INPATIENT&query=revisado&includeArchived=false&favoritesOnly=false&limit=1")).envelope.data.total).toBe(1);
    const published = structuredClone(c.store.getState().hospitalDocuments[0].revisions[0]);
    const next = await c.send("user-admin", "POST", `hospital-documents/${id}/revisions`, {}, version(6)); expect(next.status).toBe(200);
    expect(c.store.getState().hospitalDocuments[0].revisions[0]).toEqual(published); expect(c.store.getState().hospitalDocuments[0].revisions[1]).toMatchObject({ status: "DRAFT", revision: 2 });
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/revisions`, {}, version(7))).status).toBe(409);
  });

  it("duplicates an approved revision as a separate draft and retires or archives without deleting history", async () => {
    const c = await fixture(); const created = await c.send("user-admin", "POST", "hospital-documents", documentInput); const id = created.envelope.data.document.id;
    const approved = await c.send("user-vet", "POST", `hospital-documents/${id}/approve`, { expectedDraftVersion: 1, confirm: true, policyReference: "SYNTHETIC_TEST_ONLY" }, version(1)); expect(approved.status).toBe(200); const revisionId = approved.envelope.data.document.currentPublishedRevisionId;
    const copy = await c.send("user-admin", "POST", `hospital-documents/${id}/duplicate`, { code: "HTTP_PROTOCOL_COPY", title: "Cópia sintética", responsibleUserId: "user-vet", sourceRevisionId: revisionId }, version(2)); expect(copy.status).toBe(200);
    expect(copy.envelope.data.document).toMatchObject({ sourceDocumentId: id, sourceRevisionId: revisionId, version: 1 }); expect(copy.envelope.data.document.currentPublishedRevisionId).toBeUndefined();
    expect((await c.send("user-vet", "POST", `hospital-documents/${id}/retire`, { reason: "Retirada sintética", expectedRevisionId: revisionId }, version(2))).status).toBe(200);
    expect(c.store.getState().hospitalDocuments.find(doc => doc.id === id)?.revisions[0]).toMatchObject({ status: "RETIRED", content: documentInput.content });
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/archive`, { archived: true, reason: "Arquivo sintético" }, version(3))).status).toBe(200);
    expect((await c.send("user-admin", "GET", "hospital-documents")).envelope.data.total).toBe(1);
    expect((await c.send("user-admin", "GET", "hospital-documents?includeArchived=true")).envelope.data.total).toBe(2);
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/archive`, { archived: false, reason: "Restaurar biblioteca" }, version(4))).status).toBe(200);
  });

  it("keeps favorites and notes private and lets the recipient read, archive and restore publication notifications", async () => {
    const c = await fixture(); const created = await c.send("user-admin", "POST", "hospital-documents", { ...documentInput, responsibleUserId: "vet-b" }); const id = created.envelope.data.document.id;
    const preference = await c.send("vet-b", "PUT", "work-activity-preferences", { targetType: "HOSPITAL_DOCUMENT", targetId: id, favorite: true, following: true, opened: true, privateNote: "Nota privada sintética", expectedVersion: 0 }); expect(preference.status).toBe(200);
    const own = await c.send("vet-b", "GET", `work-activity-preferences?targetType=HOSPITAL_DOCUMENT&targetId=${id}&mode=FAVORITES&limit=1`); expect(own.status).toBe(200); expect(own.envelope.data.items).toHaveLength(1);
    expect(JSON.stringify((await c.send("user-vet", "GET", "work-activity-preferences")).envelope)).not.toContain("Nota privada sintética");
    expect((await c.send("user-vet", "POST", `hospital-documents/${id}/approve`, { expectedDraftVersion: 1, confirm: true, policyReference: "SYNTHETIC_TEST_ONLY" }, version(1))).status).toBe(200);
    const inbox = await c.send("vet-b", "GET", "work-notifications?includeArchived=false&unreadOnly=true&limit=1"); expect(inbox.status).toBe(200); expect(inbox.envelope.data.items).toHaveLength(1); const notification = inbox.envelope.data.items[0].notification;
    expect((await c.send("vet-b", "POST", "work-notifications/read", { notificationIds: [notification.id], read: true })).status).toBe(200);
    const current = c.store.getState().workNotifications.find(row => row.id === notification.id)!;
    expect((await c.send("vet-b", "POST", `work-notifications/${notification.id}/archive`, { archived: true }, version(current.version))).status).toBe(200);
    expect((await c.send("vet-b", "GET", "work-notifications")).envelope.data.items).toHaveLength(0);
    const archived = c.store.getState().workNotifications.find(row => row.id === notification.id)!;
    expect((await c.send("user-vet", "POST", `work-notifications/${notification.id}/archive`, { archived: false }, version(archived.version))).status).toBe(404);
    expect((await c.send("vet-b", "POST", `work-notifications/${notification.id}/archive`, { archived: false }, version(archived.version))).status).toBe(200);
    const settings = await c.send("vet-b", "GET", "work-notifications/preferences"); expect(settings.status).toBe(200);
    expect((await c.send("vet-b", "PUT", "work-notifications/preferences", { mutedEvents: ["DOCUMENT_PUBLISHED"], expectedVersion: settings.envelope.data.version })).status).toBe(200);
  });

  it("imports a hospital service without duplicating diagnostic authority or granting execution", async () => {
    const c = await fixture(); const originalUsers = structuredClone(c.store.getState().users); const originalDiagnostics = structuredClone(c.store.getState().services);
    const created = await c.send("user-admin", "POST", "hospital-services", { code: "HTTP_OPERATION", name: "Conferência operacional", kind: "OPERATIONAL", departmentCode: "INPATIENT", teamUserIds: ["user-vet"], resourceIds: [] }); expect(created.status).toBe(201); const id = created.envelope.data.id;
    expect((await c.send("user-admin", "GET", `hospital-services/${id}`)).status).toBe(200);
    expect((await c.send("user-admin", "GET", "hospital-services?departmentCode=INPATIENT&kind=OPERATIONAL&includeInactive=false&query=Conferência&limit=1")).envelope.data.total).toBe(1);
    expect((await c.send("user-admin", "PATCH", `hospital-services/${id}`, { description: "Descrição revisada" }, version(1))).status).toBe(200);
    const csv = [HOSPITAL_SERVICE_COLUMNS.join(";"), ["HTTP_IMPORTED", "Serviço importado sintético", "OPERATIONAL", "INPATIENT", "", "", "", "sim", ""].join(";")].join("\n");
    const dry = await c.send("user-admin", "POST", "hospital-services/import", { csv, dryRun: true }); expect(dry.status).toBe(200); expect(c.store.getState().hospitalServices).toHaveLength(1);
    const imported = await c.send("user-admin", "POST", "hospital-services/import", { csv, dryRun: false }); expect(imported.status).toBe(200); expect(imported.envelope.data.summary.error).toBe(0); expect(c.store.getState().hospitalServices).toHaveLength(2);
    const invalid = await c.send("user-admin", "POST", "hospital-services/import", { csv: csv.replace("HTTP_IMPORTED", "INVALID_REFERENCE").replace(";;;sim", ";;missing-resource;sim"), dryRun: false }); expect(invalid.status).toBe(422); expect(c.store.getState().hospitalServices).toHaveLength(2);
    expect(c.store.getState().services).toEqual(originalDiagnostics); expect(c.store.getState().users).toEqual(originalUsers);
    expect((await c.send("user-admin", "GET", "hospital-services?includeInactive=invalid")).status).toBe(400);
    expect((await c.send("user-admin", "POST", "hospital-services", { code: "HEMOGRAM", name: "Colisão sintética", kind: "CARE", departmentCode: "INPATIENT" })).status).toBe(409);
  });
});
