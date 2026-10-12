import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HospitalDocumentContent } from "@cvg/contracts";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createHospitalDocumentService } from "./hospital-document-service";
import { captureApprovedHospitalDocuments, visibleHospitalDocumentSnapshots } from "./hospital-document-policy";
import { systemGroupId } from "../security/access-group-policy";

const timestamp = "2026-10-11T17:00:00.000Z";
const content = (text: string): HospitalDocumentContent => ({ type: "hospital-document", version: 1, blocks: [{ type: "heading", level: 2, content: [{ text: "Instrução sintética", marks: ["strong"] }] }, { type: "paragraph", content: [{ text }] }] });
function setup() {
  const state = { ...createDemoState("synthetic-document-test-only"), hospitalDocuments: [], workActivityPreferences: [] };
  const store = new MemoryStore(state); const service = createHospitalDocumentService({ store });
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  const create = (code = "OP_TEST", departmentCode = "INPATIENT") => service.createHospitalDocument(user("user-admin"), { code, title: "Documento de teste", departmentCode, responsibleUserId: departmentCode === "INPATIENT" ? "user-vet" : "user-us", content: content("Versão inicial"), idempotencyKey: `create-${code}` });
  const approve = async () => { const view = await create(); return service.approveHospitalDocument(user("user-vet"), view.document.id, { confirm: true, policyReference: "synthetic-test-only-policy", expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "approve" }); };
  return { store, service, user, create, approve };
}
describe("operational documents and optimistic collaborative editing", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(timestamp); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("requires explicit clinical approval and records authority exclusively from the server", async () => {
    const c = setup(); const created = await c.create(); const input = { confirm: true as const, policyReference: "synthetic-test-only-policy", expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "approve" }; const before = c.store.getState();
    await expect(c.service.approveHospitalDocument(c.user("user-admin"), created.document.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.approveHospitalDocument(c.user("user-vet"), created.document.id, { ...input, approvedBy: "invented", approvedAt: "2020-01-01T00:00:00Z" } as typeof input)).rejects.toMatchObject({ status: 400 });
    await expect(c.service.approveHospitalDocument(c.user("user-vet"), created.document.id, { ...input, confirm: false } as unknown as typeof input)).rejects.toMatchObject({ status: 400 }); expect(c.store.getState()).toEqual(before);
    const approved = await c.service.approveHospitalDocument(c.user("user-vet"), created.document.id, input);
    expect(approved.document).toMatchObject({ version: 2, draftRevisionId: undefined, currentPublishedRevisionId: created.document.draftRevisionId }); expect(approved.document.revisions[0]).toMatchObject({ status: "APPROVED", approvedBy: "user-vet", approvedAt: timestamp, policyReference: input.policyReference, version: 2 });
    expect(c.store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "HospitalDocumentApproved", actorId: "user-vet", metadata: { approvedBy: "user-vet", policyReference: input.policyReference } });
    expect(JSON.stringify(c.store.getState().outbox.at(-1))).not.toContain("Versão inicial");
  });
  it("lets only one concurrent publisher win and never overwrites an approval", async () => {
    const c = setup(); const created = await c.create(); const outcomes = await Promise.allSettled(["a", "b"].map((key) => c.service.approveHospitalDocument(c.user("user-vet"), created.document.id, { confirm: true, policyReference: `synthetic-${key}`, expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: key })));
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1); expect(outcomes.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } }); expect(c.store.getState().auditEvents.filter((entry) => entry.eventType === "HospitalDocumentApproved")).toHaveLength(1);
  });
  it("protects both versions during coediting and records editor and content digests", async () => {
    const c = setup(); const created = await c.create(); const command = { expectedVersion: 1, expectedDraftVersion: 1, content: content("Nova edição"), idempotencyKey: "edit" };
    const changed = await c.service.updateHospitalDocumentDraft(c.user("user-vet"), created.document.id, command);
    expect(changed.document.revisions[0]).toMatchObject({ updatedBy: "user-vet", updatedAt: timestamp, version: 2 }); expect(c.store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ revisionVersion: 2 }); expect(c.store.getState().auditEvents.at(-1)?.metadata.contentSha256).not.toBe(c.store.getState().auditEvents.at(-1)?.metadata.previousContentSha256);
    const after = c.store.getState(); await expect(c.service.updateHospitalDocumentDraft(c.user("user-admin"), created.document.id, { ...command, title: "Outra edição", idempotencyKey: "competing-editor" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(c.service.approveHospitalDocument(c.user("user-vet"), created.document.id, { confirm: true, policyReference: "synthetic", expectedVersion: 2, expectedDraftVersion: 1, idempotencyKey: "stale-draft" })).rejects.toMatchObject({ code: "STALE_VERSION" }); expect(c.store.getState()).toEqual(after);
  });
  it("revisions approved content and preserves the exact revision already used by an activity", async () => {
    const c = setup(); const approved = await c.approve(); const snapshot = captureApprovedHospitalDocuments(c.store.getState(), c.user("user-vet"), [approved.document.id], ["INPATIENT"], timestamp); const original = structuredClone(approved.document.revisions[0]);
    await expect(c.service.updateHospitalDocumentDraft(c.user("user-admin"), approved.document.id, { content: content("Illegal overwrite"), expectedVersion: 2, expectedDraftVersion: 2, idempotencyKey: "direct-approved-edit" })).rejects.toMatchObject({ code: "DOCUMENT_DRAFT_REQUIRED" });
    const draft = await c.service.createHospitalDocumentRevision(c.user("user-admin"), approved.document.id, { content: content("Instrução futura"), expectedVersion: 2, idempotencyKey: "revise" });
    const published = await c.service.approveHospitalDocument(c.user("user-vet"), approved.document.id, { confirm: true, policyReference: "synthetic-policy-2", expectedVersion: draft.document.version, expectedDraftVersion: 1, idempotencyKey: "publish-2" });
    expect(published.document.revisions[0]).toMatchObject({ status: "RETIRED", content: original.content, approvedBy: original.approvedBy, approvedAt: original.approvedAt }); expect(published.document.revisions[1]).toMatchObject({ revision: 2, status: "APPROVED" });
    expect(visibleHospitalDocumentSnapshots(c.store.getState(), c.user("user-vet"), snapshot, ["INPATIENT"])).toEqual(snapshot); expect(snapshot[0]).toMatchObject({ revision: 1, content: original.content, policyReference: "synthetic-test-only-policy" });
  });
  it("retirement and archive stop new links without erasing history or existing snapshots", async () => {
    const c = setup(); const approved = await c.approve(); const snapshot = captureApprovedHospitalDocuments(c.store.getState(), c.user("user-vet"), [approved.document.id], ["INPATIENT"], timestamp);
    const retired = await c.service.retireHospitalDocument(c.user("user-admin"), approved.document.id, { expectedVersion: 2, expectedRevisionId: approved.document.currentPublishedRevisionId!, reason: "Retirada sintética", idempotencyKey: "retire" });
    expect(() => captureApprovedHospitalDocuments(c.store.getState(), c.user("user-vet"), [approved.document.id], ["INPATIENT"], timestamp)).toThrow("vigente"); expect(retired.document.currentPublishedRevisionId).toBe(approved.document.currentPublishedRevisionId);
    await c.service.archiveHospitalDocument(c.user("user-admin"), approved.document.id, { archived: true, reason: "Arquivo sintético", expectedVersion: 3, idempotencyKey: "archive" });
    expect(await c.service.getHospitalDocumentHistory(c.user("user-vet"), approved.document.id)).toHaveLength(1); expect(visibleHospitalDocumentSnapshots(c.store.getState(), c.user("user-vet"), snapshot, ["INPATIENT"])).toEqual(snapshot);
    expect((await c.service.listHospitalDocuments(c.user("user-vet"))).total).toBe(0); expect((await c.service.listHospitalDocuments(c.user("user-vet"), { includeArchived: true })).total).toBe(1);
  });
  it("enforces locking, scope and current permission before replay or coediting", async () => {
    const c = setup(); const created = await c.create(); const edit = { expectedVersion: 1, expectedDraftVersion: 1, title: "Edição", idempotencyKey: "edit" }; await c.service.updateHospitalDocumentDraft(c.user("user-vet"), created.document.id, edit);
    await c.service.lockHospitalDocument(c.user("user-admin"), created.document.id, { locked: true, reason: "Fechamento editorial", expectedVersion: 2, idempotencyKey: "lock" });
    await expect(c.service.updateHospitalDocumentDraft(c.user("user-admin"), created.document.id, { ...edit, expectedVersion: 3, expectedDraftVersion: 2, idempotencyKey: "locked-edit" })).rejects.toMatchObject({ code: "DOCUMENT_LOCKED" });
    const snapshot = c.store.getState(); await expect(c.service.getHospitalDocument(c.user("user-us"), created.document.id)).rejects.toMatchObject({ status: 404 }); expect(c.store.getState()).toEqual(snapshot);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_document.update") } : group) }, result: undefined }));
    await expect(c.service.updateHospitalDocumentDraft(c.user("user-vet"), created.document.id, edit)).rejects.toMatchObject({ status: 404 });
  });
  it("duplicates to a new draft identity and checks the source revision belongs to the original", async () => {
    const c = setup(); const approved = await c.approve(); const before = c.store.getState().hospitalDocuments[0];
    await expect(c.service.duplicateHospitalDocument(c.user("user-admin"), approved.document.id, { code: "COPY", title: "Cópia", responsibleUserId: "user-vet", sourceRevisionId: "foreign-revision", expectedVersion: 2, idempotencyKey: "foreign" })).rejects.toMatchObject({ status: 400 });
    const copied = await c.service.duplicateHospitalDocument(c.user("user-admin"), approved.document.id, { code: "COPY", title: "Cópia", responsibleUserId: "user-vet", expectedVersion: 2, idempotencyKey: "copy" });
    expect(copied.document.id).not.toBe(before.id); expect(copied.document).toMatchObject({ sourceDocumentId: before.id, sourceRevisionId: before.currentPublishedRevisionId }); expect(copied.document.currentPublishedRevisionId).toBeUndefined(); expect(copied.document.revisions[0]).toMatchObject({ status: "DRAFT", content: before.revisions[0].content }); expect(c.store.getState().hospitalDocuments[0]).toEqual(before);
  });
  it.each(["HTML", "SCRIPT_LINK", "CREDENTIAL_LINK", "RAGGED_TABLE", "SPOOFED_MARK"])("rejects unsafe rich content %s without any write", async (kind) => {
    const c = setup(); const rich: unknown = kind === "HTML" ? { type: "hospital-document", version: 1, blocks: [{ type: "html", html: "<img src=x onerror=alert(1)>" }] } : kind === "RAGGED_TABLE" ? { type: "hospital-document", version: 1, blocks: [{ type: "table", header: true, rows: [[[{ text: "x" }]], [[{ text: "x" }], [{ text: "y" }]]] }] } : { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Link", ...(kind === "SPOOFED_MARK" ? { marks: ["onclick"] } : { href: kind === "SCRIPT_LINK" ? "javascript:alert(1)" : "https://user:password@example.invalid" }) }] }] };
    const before = c.store.getState(); await expect(c.service.createHospitalDocument(c.user("user-admin"), { code: "UNSAFE", title: "Inválido", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich as HospitalDocumentContent, idempotencyKey: "unsafe" })).rejects.toMatchObject({ status: 400 }); expect(c.store.getState()).toEqual(before);
  });
  it("paginates without loss, binds cursors to actor and filters, and isolates favorites", async () => {
    const c = setup(); const base = await c.create(); await c.store.transaction((state) => ({ state: { ...state, hospitalDocuments: Array.from({ length: 11 }, (_, i) => ({ ...base.document, id: `doc-${i}`, code: `OP_${String(i).padStart(3, "0")}` })) }, result: undefined }));
    const seen: string[] = []; let cursor: string | undefined; do { const page = await c.service.listHospitalDocuments(c.user("user-vet"), { limit: 3, cursor }); seen.push(...page.items.map((entry) => entry.id)); cursor = page.nextCursor; } while (cursor); expect(new Set(seen).size).toBe(11); expect(seen).toHaveLength(11);
    const first = await c.service.listHospitalDocuments(c.user("user-vet"), { limit: 3 }); await expect(c.service.listHospitalDocuments(c.user("user-vet"), { limit: 3, favoritesOnly: true, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 }); await expect(c.service.listHospitalDocuments(c.user("user-manager"), { limit: 3, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
    await c.store.transaction((state) => ({ state: { ...state, workActivityPreferences: [{ id: "preference-other", userId: "user-manager", targetType: "HOSPITAL_DOCUMENT", targetId: "doc-0", favorite: true, following: false, hiddenFromRecents: false, version: 1, createdAt: timestamp, updatedAt: timestamp }] }, result: undefined }));
    expect((await c.service.listHospitalDocuments(c.user("user-vet"), { favoritesOnly: true })).total).toBe(0); expect((await c.service.listHospitalDocuments(c.user("user-manager"), { favoritesOnly: true })).items.map((entry) => entry.id)).toEqual(["doc-0"]);
  });
  it("removes a historical snapshot when its current document grant is revoked", async () => {
    const c = setup(); const approved = await c.approve(); const snapshot = captureApprovedHospitalDocuments(c.store.getState(), c.user("user-vet"), [approved.document.id], ["INPATIENT"], timestamp);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_document.view") } : group) }, result: undefined }));
    const current = c.store.getState().users.find((entry) => entry.id === "user-vet")!;
    await expect(c.service.getHospitalDocument(current, approved.document.id)).rejects.toMatchObject({ status: 404 });
    expect(visibleHospitalDocumentSnapshots(c.store.getState(), current, snapshot, ["INPATIENT"])).toEqual([]);
  });
  it("pins metadata responsibility and replay without exposing later coeditors' content to create-only callers", async () => {
    const c = setup(); const created = await c.create();
    await expect(c.create()).resolves.toEqual(created);
    await expect(c.service.createHospitalDocument(c.user("user-admin"), { code: "OP_TEST", title: "Duplicate", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: content("Other"), idempotencyKey: "different-create" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(c.service.updateHospitalDocumentMetadata(c.user("user-admin"), created.document.id, { responsibleUserId: "user-lab", expectedVersion: 1, idempotencyKey: "wrong-responsible" })).rejects.toMatchObject({ code: "DOCUMENT_RESPONSIBLE_UNAVAILABLE" });
    const metadata = await c.service.updateHospitalDocumentMetadata(c.user("user-admin"), created.document.id, { responsibleUserId: "user-vet", expectedVersion: 1, idempotencyKey: "metadata" });
    expect(metadata.document.version).toBe(2); expect(metadata.document.revisions).toEqual(created.document.revisions);
    await expect(c.service.createHospitalDocumentRevision(c.user("user-admin"), created.document.id, { expectedVersion: 2, idempotencyKey: "draft-already-exists" })).rejects.toMatchObject({ code: "DOCUMENT_DRAFT_EXISTS" });
    const edited = await c.service.updateHospitalDocumentDraft(c.user("user-vet"), created.document.id, { title: "Novo título", expectedVersion: 2, expectedDraftVersion: 1, idempotencyKey: "title-only" });
    expect(edited.document.revisions[0].content).toEqual(created.document.revisions[0].content);
    const copyInput = { code: "DRAFT_COPY", title: "Cópia do draft", responsibleUserId: "user-vet", expectedVersion: 3, idempotencyKey: "copy-draft" };
    const copy = await c.service.duplicateHospitalDocument(c.user("user-admin"), created.document.id, copyInput);
    expect(copy.document.sourceRevisionId).toBe(created.document.draftRevisionId);
    expect(await c.service.duplicateHospitalDocument(c.user("user-admin"), created.document.id, copyInput)).toEqual(copy);
    expect((await c.create()).document.revisions[0].title).toBe(created.document.revisions[0].title);
  });
  it("rejects retirement of a different revision and restores an archive only while its sector is active", async () => {
    const c = setup(); const approved = await c.approve();
    await expect(c.service.retireHospitalDocument(c.user("user-admin"), approved.document.id, { expectedVersion: 2, expectedRevisionId: "another-revision", reason: "Synthetic", idempotencyKey: "wrong-retirement" })).rejects.toMatchObject({ code: "DOCUMENT_REVISION_NOT_CURRENT" });
    const retired = await c.service.retireHospitalDocument(c.user("user-admin"), approved.document.id, { expectedVersion: 2, expectedRevisionId: approved.document.currentPublishedRevisionId!, reason: "Synthetic", idempotencyKey: "retired" });
    const draft = await c.service.createHospitalDocumentRevision(c.user("user-admin"), approved.document.id, { expectedVersion: retired.document.version, idempotencyKey: "after-retired" });
    await c.service.approveHospitalDocument(c.user("user-vet"), approved.document.id, { confirm: true, policyReference: "synthetic-policy-new", expectedVersion: draft.document.version, expectedDraftVersion: 1, idempotencyKey: "approve-after-retired" });
    const archived = await c.service.archiveHospitalDocument(c.user("user-admin"), approved.document.id, { archived: true, reason: "Synthetic", expectedVersion: 5, idempotencyKey: "archive" });
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((entry) => entry.code === "INPATIENT" ? { ...entry, active: false } : entry) }, result: undefined }));
    await expect(c.service.archiveHospitalDocument(c.user("user-admin"), approved.document.id, { archived: false, reason: "Synthetic", expectedVersion: archived.document.version, idempotencyKey: "restore" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((entry) => entry.code === "INPATIENT" ? { ...entry, active: true } : entry) }, result: undefined }));
    const restored = await c.service.archiveHospitalDocument(c.user("user-admin"), approved.document.id, { archived: false, reason: "Synthetic", expectedVersion: archived.document.version, idempotencyKey: "restore" });
    expect(restored.document.archived).toBe(false); expect(restored.document.revisions).toEqual(archived.document.revisions);
  });
  it("denies new documents and duplicates when the module is disabled while preserving editorial and historical work", async () => {
    const c = setup(); const approved = await c.approve();
    await c.store.transaction((state) => ({ state: { ...state, hospitalInstitutionSettings: [{ id: "hospital-institution", name: "Synthetic", timezone: "America/Sao_Paulo", departmentCapabilities: [{ departmentCode: "INPATIENT", archived: false, disabledNewWork: ["DOCUMENTS"] }], version: 1, updatedAt: timestamp, updatedBy: "user-admin" }] }, result: undefined }));
    await expect(c.create("DISABLED")).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
    await expect(c.service.duplicateHospitalDocument(c.user("user-admin"), approved.document.id, { code: "DISABLED_COPY", title: "Cópia", responsibleUserId: "user-vet", expectedVersion: 2, idempotencyKey: "disabled-copy" })).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
    expect((await c.service.getHospitalDocument(c.user("user-vet"), approved.document.id)).document.revisions[0].status).toBe("APPROVED");
    expect((await c.service.createHospitalDocumentRevision(c.user("user-admin"), approved.document.id, { expectedVersion: 2, idempotencyKey: "existing-revision" })).document.draftRevisionId).toBeTruthy();
  });
});
