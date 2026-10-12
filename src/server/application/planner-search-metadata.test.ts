import { describe, expect, it } from "vitest";
import type { HospitalDocumentContent, PlannerSearchResult } from "@cvg/contracts";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";

const content: HospitalDocumentContent = { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "PRIVATE_DOCUMENT_BODY_NOT_A_SEARCH_RESULT" }] }] };

async function fixture() {
  const c = hospitalOperationFixture();
  const document = await c.service.createHospitalDocument(c.user("user-admin"), { code: "META_DOC", title: "Conferência documental", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content, idempotencyKey: "metadata-document" });
  const resource = await c.resource({ code: "META_ROOM", name: "Conferência sala", kind: "ROOM", departmentCode: "INPATIENT" });
  const otherDocument = await c.service.createHospitalDocument(c.user("user-admin"), { code: "META_DOC_LAB", title: "Conferência documental restrita", departmentCode: "LABORATORY", responsibleUserId: "user-lab", content, idempotencyKey: "metadata-document-lab" });
  const otherResource = await c.resource({ code: "META_ROOM_LAB", name: "Conferência sala restrita", kind: "ROOM", departmentCode: "LABORATORY" });
  return { ...c, document: document.document, resource, otherDocument: otherDocument.document, otherResource };
}

describe("planner search includes the delivered document library and resource inventory", () => {
  it("finds authorized metadata with links that open the exact native object, without returning document content", async () => {
    const c = await fixture();
    const page = await c.service.searchPlanner(c.user("user-vet"), "Conferência");
    expect(page.items.filter(row => row.type === "HOSPITAL_DOCUMENT" || row.type === "HOSPITAL_RESOURCE")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "HOSPITAL_DOCUMENT", id: c.document.id, label: "META_DOC · Conferência documental", departmentCode: "INPATIENT", responsibleUserId: "user-vet", status: "DRAFT", deepLink: `/planner/documents/${c.document.id}` }),
      expect.objectContaining({ type: "HOSPITAL_RESOURCE", id: c.resource.id, label: "META_ROOM · Conferência sala", departmentCode: "INPATIENT", status: "AVAILABLE", deepLink: `/admin/resources?resourceId=${c.resource.id}` })
    ]));
    expect(page.total).toBe(2);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_DOCUMENT_BODY|revisions|responsável restrito|META_DOC_LAB|META_ROOM_LAB/);
    expect((await c.service.getHospitalDocument(c.user("user-vet"), c.document.id)).document.id).toBe(c.document.id);
    expect((await c.service.getHospitalResource(c.user("user-vet"), c.resource.id)).id).toBe(c.resource.id);
    await expect(c.service.getHospitalDocument(c.user("user-vet"), c.otherDocument.id)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getHospitalResource(c.user("user-vet"), c.otherResource.id)).rejects.toMatchObject({ status: 404 });
  });

  it("searches identification and applies each source's period, department, status and responsibility", async () => {
    const c = await fixture();
    expect((await c.service.searchPlanner(c.user("user-vet"), c.document.id, { types: ["HOSPITAL_DOCUMENT"] })).items.map(row => row.id)).toEqual([c.document.id]);
    expect((await c.service.searchPlanner(c.user("user-vet"), c.resource.id, { types: ["HOSPITAL_RESOURCE"] })).items.map(row => row.id)).toEqual([c.resource.id]);
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_DOCUMENT"], responsibleUserId: "user-vet", from: c.document.updatedAt, to: c.document.updatedAt, status: "DRAFT" })).total).toBe(1);
    for (const filters of [{ responsibleUserId: "user-lab" }, { departmentCode: "LABORATORY" }, { from: "2090-01-01T00:00:00Z" }, { to: "2000-01-01T00:00:00Z" }, { status: "APPROVED" }]) {
      expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_DOCUMENT"], ...filters })).total).toBe(0);
    }
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_DOCUMENT"], assignedToMe: true })).total).toBe(1);
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_RESOURCE"], assignedToMe: true })).total).toBe(0);
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_RESOURCE"], status: "BLOCKED" })).total).toBe(0);
    for (const filters of [{ patientId: "patient-thor" }, { encounterId: "encounter-thor" }, { priority: "URGENT" as const }, { phase: "PENDING" as const }, { typeId: "hospital-task-type-routine" }, { label: "urgent" }]) {
      expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { ...filters, types: ["HOSPITAL_DOCUMENT", "HOSPITAL_RESOURCE"] })).total).toBe(0);
    }
  });

  it("does not infer a document or resource grant from the actor's role, including after revocation", async () => {
    const c = await fixture(); const snapshot = c.user("user-vet");
    const baseline = c.store.getState().accessGroups.find(group => group.id === snapshot.accessGroupId)!;
    await c.store.transaction(state => ({ state: { ...state, accessGroups: [...state.accessGroups, { ...baseline, id: "metadata-reduced", code: "META_REDUCED", description: "Pesquisa sem metadados", systemRole: undefined, permissions: baseline.permissions.filter(permission => permission !== "hospital_document.view" && permission !== "hospital_resource.view") }], users: state.users.map(user => user.id === snapshot.id ? { ...user, accessGroupId: "metadata-reduced" } : user) }, result: undefined }));
    const page = await c.service.searchPlanner(snapshot, "Conferência", { types: ["HOSPITAL_DOCUMENT", "HOSPITAL_RESOURCE"] });
    expect(page).toMatchObject({ items: [], total: 0 });
    expect(JSON.stringify(page)).not.toMatch(/META_DOC|META_ROOM|Conferência documental/);
    await expect(c.service.getHospitalDocument(snapshot, c.document.id)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getHospitalResource(snapshot, c.resource.id)).rejects.toMatchObject({ status: 404 });
  });

  it("counts and paginates only delegated sources, with no duplicate IDs or hidden titles", async () => {
    const c = await fixture();
    await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["INPATIENT"] } : user) }, result: undefined }));
    const types: PlannerSearchResult["type"][] = ["HOSPITAL_DOCUMENT", "HOSPITAL_RESOURCE"];
    const first = await c.service.searchPlanner(c.user("user-manager"), "Conferência", { types, limit: 1 });
    expect(first.total).toBe(2); expect(first.nextCursor).toBeDefined();
    const second = await c.service.searchPlanner(c.user("user-manager"), "Conferência", { types, limit: 1, cursor: first.nextCursor });
    expect(second.total).toBe(2); expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map(row => `${row.type}:${row.id}`)).size).toBe(2);
    expect(JSON.stringify([first, second])).not.toMatch(/META_DOC_LAB|META_ROOM_LAB|restrita/);
  });

  it("distinguishes archived document history and inactive inventory from operative availability", async () => {
    const c = await fixture();
    await c.service.archiveHospitalDocument(c.user("user-admin"), c.document.id, { archived: true, reason: "Arquivo sintético para verificar referências históricas autorizadas.", expectedVersion: c.document.version, idempotencyKey: "archive-metadata-document" });
    await c.service.updateHospitalResource(c.user("user-admin"), c.resource.id, { active: false, expectedVersion: c.resource.version, idempotencyKey: "deactivate-metadata-resource" });
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_DOCUMENT"] })).total).toBe(0);
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_DOCUMENT"], includeArchived: true })).items[0]).toMatchObject({ id: c.document.id, status: "ARCHIVED" });
    expect((await c.service.searchPlanner(c.user("user-vet"), "Conferência", { types: ["HOSPITAL_RESOURCE"] })).items[0]).toMatchObject({ id: c.resource.id, status: "INACTIVE", deepLink: `/admin/resources?resourceId=${c.resource.id}` });
  });
});
