import { describe, expect, it } from "vitest";
import type { StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import { createApplicationService } from "./service";

function userByEmail(state: StoreState, email: string): User {
  const user = state.users.find((entry) => entry.email === email);
  if (!user) throw new Error(`fixture actor missing: ${email}`);
  return user;
}

async function archivedStore(mutate: (state: StoreState) => StoreState = (state) => state) {
  let state = createDemoState("archive-service-password");
  state = withCompletedRequest(state, "old");
  state = withCompletedRequest(state, "mel", { patientId: "patient-mel" });
  state = mutate(state);
  const store = new MemoryStore(state);
  await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
  const service = createApplicationService(store);
  const actor = (email: string) => userByEmail(store.getState(), email);
  return { store, service, actor };
}

describe("archive reads", () => {
  it("lists a patient's archived requests for an authorized clinician", async () => {
    const { service, actor } = await archivedStore();
    const entries = await service.listPatientArchive(actor("vet@cvg.local"), "patient-thor");
    expect(entries.map((entry) => entry.requestCode)).toEqual(["EX-old"]);
    expect(entries[0].services.map((item) => item.name)).toEqual(["Hemograma", "RX de tórax"]);
    expect(await service.listPatientArchive(actor("vet@cvg.local"), "patient-thor", { limit: 1 })).toHaveLength(1);
  });

  it("answers 404 for unknown patients, patients out of scope and roles without patient access", async () => {
    const { service, actor } = await archivedStore();
    const vet = actor("vet@cvg.local");
    await expect(service.listPatientArchive(vet, "patient-missing")).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    await expect(service.listPatientArchive(vet, "patient-mel-2")).rejects.toMatchObject({ status: 404 });
    await expect(service.listPatientArchive(actor("admin@cvg.local"), "patient-thor")).rejects.toMatchObject({ status: 404 });
    await expect(service.listPatientArchive(vet, "patient-thor", { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listPatientArchive(vet, "patient-thor", { limit: 101 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("scopes executors by their own departments and services, even without active exams", async () => {
    const { service, actor } = await archivedStore();
    expect((await service.listPatientArchive(actor("lab@cvg.local"), "patient-thor")).map((entry) => entry.requestCode)).toEqual(["EX-old"]);
    expect((await service.listPatientArchive(actor("rx@cvg.local"), "patient-thor")).map((entry) => entry.requestCode)).toEqual(["EX-old"]);
    await expect(service.listPatientArchive(actor("us@cvg.local"), "patient-thor")).rejects.toMatchObject({ status: 404 });
    await expect(service.getArchivedRequest(actor("us@cvg.local"), "request-old")).rejects.toMatchObject({ status: 404 });
  });

  it("scopes managers by department delegation", async () => {
    const { service, actor, store } = await archivedStore();
    expect((await service.listPatientArchive(actor("manager@cvg.local"), "patient-thor")).map((entry) => entry.requestCode)).toEqual(["EX-old"]);
    const restricted = { ...actor("manager@cvg.local"), departmentCode: "ULTRASOUND", managedDepartmentCodes: ["ULTRASOUND"] };
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => (user.id === restricted.id ? restricted : user)) }, result: undefined }));
    await expect(service.listPatientArchive(restricted, "patient-thor")).rejects.toMatchObject({ status: 404 });
    await expect(service.getArchivedRequest(restricted, "request-old")).rejects.toMatchObject({ status: 404 });
  });

  it("gives a manager only the items of the delegated department, in the list summary and in the detail (AUD-05)", async () => {
    const { service, actor, store } = await archivedStore((state) => {
      const labResult = state.results.find((entry) => entry.id === "result-old")!;
      const labVersion = state.resultVersions.find((entry) => entry.id === "version-old-2")!;
      return {
        ...state,
        users: state.users.map((user) => user.email === "manager@cvg.local" ? { ...user, departmentCode: "LABORATORY", managedDepartmentCodes: ["LABORATORY"] } : user),
        results: [...state.results, { ...labResult, id: "result-rx-old", itemId: "item-rx-old", currentVersionId: "version-rx-old" }],
        resultVersions: [...state.resultVersions, { ...labVersion, id: "version-rx-old", resultId: "result-rx-old", narrative: "Narrativa privada da radiologia." }]
      };
    });
    const manager = actor("manager@cvg.local");
    const [entry] = await service.listPatientArchive(manager, "patient-thor");
    expect(entry.services.map((item) => item.departmentCode)).toEqual(["LABORATORY"]);
    expect(entry.attachmentCount).toBe(1);
    const archived = await service.getArchivedRequest(manager, "request-old");
    expect(archived.items.map((item) => item.departmentCode)).toEqual(["LABORATORY"]);
    expect(JSON.stringify(archived)).not.toContain("Narrativa privada da radiologia.");
    expect(archived.samples).toHaveLength(1);
    expect(archived.attachments).toHaveLength(1);
    // The inverse delegation sees the radiology narrative and none of the laboratory artefacts.
    const rxManager = { ...manager, departmentCode: "RADIOLOGY", managedDepartmentCodes: ["RADIOLOGY"] };
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => (user.id === manager.id ? rxManager : user)) }, result: undefined }));
    const rx = await service.getArchivedRequest(rxManager, "request-old");
    expect(rx.items.map((item) => item.departmentCode)).toEqual(["RADIOLOGY"]);
    expect(JSON.stringify(rx)).toContain("Narrativa privada da radiologia.");
    expect(JSON.stringify(rx)).not.toContain("Versão final.");
    expect(rx.samples).toEqual([]);
    expect(rx.attachments).toEqual([]);
    expect((await service.listPatientArchive(rxManager, "patient-thor"))[0]).toMatchObject({ services: [expect.objectContaining({ code: "XRAY_THORAX" })], attachmentCount: 0 });
    // A manager of the requesting department keeps the request, with no items, as in the active aggregate.
    const inpatient = { ...manager, departmentCode: "INPATIENT", managedDepartmentCodes: ["INPATIENT"] };
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => (user.id === manager.id ? inpatient : user)) }, result: undefined }));
    expect((await service.listPatientArchive(inpatient, "patient-thor"))[0]).toMatchObject({ requestCode: "EX-old", services: [], attachmentCount: 0 });
    expect((await service.getArchivedRequest(inpatient, "request-old")).items).toEqual([]);
  });

  it("shows an executor only the services of their own scope in the list summary (AUD-05)", async () => {
    const { service, actor } = await archivedStore();
    const [forLab] = await service.listPatientArchive(actor("lab@cvg.local"), "patient-thor");
    expect(forLab.services.map((item) => item.code)).toEqual(["HEMOGRAM"]);
    expect(forLab.attachmentCount).toBe(1);
    const [forRx] = await service.listPatientArchive(actor("rx@cvg.local"), "patient-thor");
    expect(forRx.services.map((item) => item.code)).toEqual(["XRAY_THORAX"]);
    expect(forRx.attachmentCount).toBe(0);
    const [forVet] = await service.listPatientArchive(actor("vet@cvg.local"), "patient-thor");
    expect(forVet.services.map((item) => item.code)).toEqual(["HEMOGRAM", "XRAY_THORAX"]);
    expect(forVet.attachmentCount).toBe(1);
  });

  it("applies the scope before the limit, so a newer foreign record never hides an older visible one (AUD-08)", async () => {
    const { service, actor } = await archivedStore((state) => {
      let next = withCompletedRequest(state, "lab-old", { at: "2024-04-01T12:00:00.000Z" });
      next = withCompletedRequest(next, "rx-new", { at: "2024-07-01T12:00:00.000Z" });
      return { ...next, items: next.items.map((item) => item.requestId === "request-rx-new" ? { ...item, departmentCode: "RADIOLOGY", serviceId: "service-xray", workflowType: "RADIOLOGY" as const } : item) };
    });
    const lab = actor("lab@cvg.local");
    expect((await service.listPatientArchive(lab, "patient-thor", { limit: 1 })).map((entry) => entry.requestId)).toEqual(["request-old"]);
    expect((await service.listPatientArchive(lab, "patient-thor", { limit: 2 })).map((entry) => entry.requestId)).toEqual(["request-old", "request-lab-old"]);
    expect((await service.listPatientArchive(lab, "patient-thor")).map((entry) => entry.requestId)).toEqual(["request-old", "request-lab-old"]);
    // A radiology-only executor still finds the newest record first.
    expect((await service.listPatientArchive(actor("rx@cvg.local"), "patient-thor", { limit: 1 })).map((entry) => entry.requestId)).toEqual(["request-rx-new"]);
  });

  it("uses the active aggregate for scope when the patient also has current exams", async () => {
    const { service, actor } = await archivedStore((state) => withCompletedRequest(state, "current", { at: "2026-10-01T12:00:00.000Z" }));
    expect(await service.listPatientArchive(actor("lab@cvg.local"), "patient-thor")).toHaveLength(1);
    expect(await service.listPatientArchive(actor("manager@cvg.local"), "patient-thor")).toHaveLength(1);
  });

  it("returns the archived request read-only, with released versions and no drafts", async () => {
    const { service, actor } = await archivedStore((state) => ({
      ...state,
      resultVersions: [...state.resultVersions, { ...state.resultVersions[0], id: "version-old-draft", sequence: 9, status: "DRAFT" as const, narrative: "rascunho secreto", releasedAt: undefined }]
    }));
    const view = await service.getArchivedRequest(actor("vet@cvg.local"), "request-old");
    expect(view).toMatchObject({ readOnly: true, archivedAt: ARCHIVE_NOW.toISOString(), request: { requestCode: "EX-old", aggregateStatus: "COMPLETED" }, patient: { id: "patient-thor", displayName: "Thor" } });
    expect(view.items.map((item) => item.service.code)).toEqual(["HEMOGRAM", "XRAY_THORAX"]);
    const versions = view.items[0].results[0].versions;
    expect(versions.map((version) => version.sequence)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ status: "RELEASED", narrative: "Versão final.", conclusion: "Sem alterações.", amendmentReason: "Correção", content: { kind: "NARRATIVE" } });
    expect(JSON.stringify(view)).not.toContain("rascunho secreto");
    expect(view.samples).toHaveLength(1);
    expect(view.attachments).toEqual([{ id: "attachment-old", resultVersionId: "version-old-2", safeName: "laudo.pdf", detectedMime: "application/pdf", sizeBytes: 2048 }]);
    expect(JSON.stringify(view)).not.toContain("storageKey");
  });

  it("limits an executor to the items, samples and attachments of their own service", async () => {
    const { service, actor } = await archivedStore();
    const rx = await service.getArchivedRequest(actor("rx@cvg.local"), "request-old");
    expect(rx.items.map((item) => item.service.code)).toEqual(["XRAY_THORAX"]);
    expect(rx.samples).toEqual([]);
    expect(rx.attachments).toEqual([]);
    const lab = await service.getArchivedRequest(actor("lab@cvg.local"), "request-old");
    expect(lab.items.map((item) => item.service.code)).toEqual(["HEMOGRAM"]);
    expect(lab.samples).toHaveLength(1);
    expect(lab.attachments).toHaveLength(1);
  });

  it("answers 404 for unknown requests, other patients' requests and admins", async () => {
    const { service, actor } = await archivedStore();
    const vet = actor("vet@cvg.local");
    await expect(service.getArchivedRequest(vet, "request-missing")).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    await expect(service.getArchivedRequest(actor("admin@cvg.local"), "request-old")).rejects.toMatchObject({ status: 404 });
    // A veterinarian without the patient in scope sees nothing of it.
    const outsider = { ...vet, patientIds: ["patient-mel-2"] };
    await expect(service.getArchivedRequest(outsider, "request-old")).rejects.toMatchObject({ status: 404 });
  });

  it("tolerates a removed patient and a retired service", async () => {
    const { service, actor, store } = await archivedStore();
    await store.transaction((state) => ({ state: { ...state, patients: state.patients.filter((patient) => patient.id !== "patient-thor"), services: [] }, result: undefined }));
    const view = await service.getArchivedRequest(actor("vet@cvg.local"), "request-old");
    expect(view.patient).toBeNull();
    expect(view.items.map((item) => item.service)).toEqual([{ code: "service-hemogram", name: "service-hemogram" }, { code: "service-xray", name: "service-xray" }]);
  });

  it("omits optional item fields that were never set and keeps cancellation and rejection reasons", async () => {
    const { service, actor } = await archivedStore((state) => ({
      ...state,
      items: state.items.map((item) => (item.id === "item-rx-old" ? { ...item, status: "REJECTED" as const, completedAt: undefined, rejectionReason: "Inviável", cancellationReason: "Duplicado", note: "Obs" } : item))
    }));
    const view = await service.getArchivedRequest(actor("vet@cvg.local"), "request-old");
    expect(view.items[0]).not.toHaveProperty("note");
    expect(view.items[1]).toMatchObject({ rejectionReason: "Inviável", cancellationReason: "Duplicado", note: "Obs" });
    expect(view.items[1]).not.toHaveProperty("completedAt");
  });
});
