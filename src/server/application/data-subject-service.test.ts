import { describe, expect, it, vi } from "vitest";
import type { ClinicalArchiveRow, ResultVersion, StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { ARCHIVE_NOW, RECENT, withCompletedRequest } from "../../test/archive-fixtures";
import { buildPatientDataExport, PATIENT_DATA_EXPORT_FORMAT, PATIENT_DATA_EXPORT_OMITS } from "./data-subject-service";
import { createApplicationService } from "./service";

function stateWithHistory(mutate: (state: StoreState) => StoreState = (state) => state): StoreState {
  let state = createDemoState("data-subject-password");
  state = withCompletedRequest(state, "old");
  state = withCompletedRequest(state, "recent", { at: RECENT });
  state = withCompletedRequest(state, "mel", { patientId: "patient-mel" });
  return mutate(state);
}

async function exportContext(mutate?: (state: StoreState) => StoreState) {
  const store = new MemoryStore(stateWithHistory(mutate));
  // "old" and "mel" are past the 24-month window; "recent" stays active.
  await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
  const service = createApplicationService(store);
  const user = (role: string) => store.getState().users.find((entry) => entry.role === role)!;
  /** A real session of the user, confirmed `confirmedAgoMs` ago (the step-up is read from the stored session). */
  const signedIn = async (actor: User, confirmedAgoMs?: number): Promise<User> => {
    const sessionId = `session-${actor.id}-${confirmedAgoMs ?? "none"}`;
    const now = Date.now();
    await store.transaction((state) => ({ state: { ...state, sessions: [...state.sessions, {
      id: sessionId, userId: actor.id, tokenHash: `token-${sessionId}`, csrfTokenHash: `csrf-${sessionId}`, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(), version: 1,
      ...(confirmedAgoMs === undefined ? {} : { reauthenticatedAt: new Date(now - confirmedAgoMs).toISOString() })
    }] }, result: undefined }));
    return { ...actor, sessionId };
  };
  const reauthenticated = (actor: User) => signedIn(actor, 0);
  return { store, service, user, signedIn, reauthenticated };
}

describe("LGPD export of a patient's records (PROD-502)", () => {
  it("exports the active and the archived history of the patient, newest first, and audits it", async () => {
    const { store, service, user, reauthenticated } = await exportContext();
    const admin = await reauthenticated(user("ADMIN"));
    const exported = await service.exportPatientData(admin, "his-thor-001", { correlationId: "corr-export" });

    expect(exported.format).toBe(PATIENT_DATA_EXPORT_FORMAT);
    expect(exported.patient).toEqual({ externalId: "HIS-THOR-001", displayName: "Thor", species: "Canino", breed: "Labrador", sex: "Macho", birthDate: "2019-04-12", ownerLabel: "A. Oliveira", active: true });
    expect(exported.encounters.map((encounter) => encounter.externalId)).toEqual(["ATD-THOR-001"]);
    expect(exported.requests.map((request) => [request.requestCode, request.archived])).toEqual([["EX-recent", false], ["EX-old", true]]);
    const [recent, old] = exported.requests;
    for (const request of [recent, old]) {
      expect(request.encounterExternalId).toBe("ATD-THOR-001");
      expect(request.items.map((item) => item.service.code)).toEqual(["HEMOGRAM", "XRAY_THORAX"]);
      const lab = request.items[0];
      expect(lab.samples).toEqual([expect.objectContaining({ sampleType: "EDTA", status: "RECEIVED" })]);
      expect(lab.results).toEqual([{ status: "RELEASED", versions: [
        expect.objectContaining({ sequence: 1, status: "SUPERSEDED", narrative: "Primeira versão." }),
        expect.objectContaining({ sequence: 2, status: "RELEASED", narrative: "Versão final.", conclusion: "Sem alterações.", amendmentReason: "Correção" })
      ] }]);
      expect(lab.attachments).toEqual([{ safeName: "laudo.pdf", detectedMime: "application/pdf", sizeBytes: 2048, createdAt: expect.any(String) }]);
    }
    // Another patient's request never appears, even archived together.
    expect(JSON.stringify(exported)).not.toContain("EX-mel");
    expect(exported.omitted).toEqual(PATIENT_DATA_EXPORT_OMITS);

    const audit = store.getState().auditEvents.filter((event) => event.eventType === "PatientDataExported");
    expect(audit).toEqual([expect.objectContaining({ actorId: admin.id, entityType: "Patient", entityId: "patient-thor", correlationId: "corr-export", metadata: { requests: 1, archivedRequests: 1 } })]);
  });

  it("leaves out staff identities, drafts, storage keys and unfinished uploads", async () => {
    const draft: ResultVersion = { id: "version-recent-draft", resultId: "result-recent", sequence: 3, status: "DRAFT", content: { kind: "NARRATIVE" }, narrative: "Rascunho interno.", authorId: "user-lab", createdAt: RECENT, critical: false, needsReReview: false, version: 1 };
    const { service, user, reauthenticated } = await exportContext((state) => ({
      ...state,
      resultVersions: [...state.resultVersions, draft],
      attachments: [...state.attachments, { ...state.attachments.find((entry) => entry.id === "attachment-recent")!, id: "attachment-pending", safeName: "pendente.pdf", uploadStatus: "UPLOADED" }]
    }));
    const text = JSON.stringify(await service.exportPatientData(await reauthenticated(user("ADMIN")), "HIS-THOR-001"));
    for (const hidden of ["Rascunho interno.", "pendente.pdf", "attachments/", "user-lab", "user-vet", "user-rx", "@cvg.local", "Técnica Joana", "Marina Costa", "storageKey", "checksum", "authorId", "requesterId"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("is only for an ADMIN who just confirmed their password, and only for a known medical-record number", async () => {
    const { store, service, user, signedIn, reauthenticated } = await exportContext();
    // Never confirmed, confirmed 11 minutes ago, or a step-up claimed by the caller instead of stored: refused.
    await expect(service.exportPatientData(await signedIn(user("ADMIN")), "HIS-THOR-001")).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    await expect(service.exportPatientData(await signedIn(user("ADMIN"), 11 * 60_000), "HIS-THOR-001")).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    const forged = { ...(await signedIn(user("ADMIN"))), reauthenticatedAt: new Date().toISOString() };
    await expect(service.exportPatientData(forged, "HIS-THOR-001")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    // Clinical roles keep their patient scope; the export is not theirs to run.
    for (const role of ["VETERINARIAN", "MANAGER", "LAB_TECH"]) {
      await expect(service.exportPatientData(await reauthenticated(user(role)), "HIS-THOR-001")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    }
    const admin = await reauthenticated(user("ADMIN"));
    await expect(service.exportPatientData(admin, "HIS-NOBODY")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(service.exportPatientData(admin, "   ")).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    // Refusals are not exports: nothing audited.
    expect(store.getState().auditEvents.some((event) => event.eventType === "PatientDataExported")).toBe(false);
  });

  it("keeps optional fields only when present and ignores archive rows of other patients", () => {
    const base = withCompletedRequest(withCompletedRequest(createDemoState("data-subject-password"), "a", { at: RECENT }), "b", { at: RECENT });
    const state: StoreState = {
      ...base,
      patients: base.patients.map((patient) => patient.id === "patient-thor" ? { ...patient, birthDate: undefined } : patient),
      encounters: base.encounters.map((encounter) => encounter.id === "encounter-thor" ? { ...encounter, status: "CLOSED", closedAt: RECENT } : encounter),
      admissions: base.admissions.map((admission) => ({ ...admission, dischargedAt: RECENT })),
      items: base.items.map((item) => item.id === "item-rx-a"
        ? { ...item, serviceId: "service-retired", status: "CANCELLED", completedAt: undefined, cancellationReason: "Desistência", rejectionReason: "Pedido duplicado" }
        : item),
      samples: base.samples.map((sample) => ({ ...sample, collectedAt: undefined, receivedAt: undefined })),
      resultVersions: base.resultVersions.map((version) => ({ ...version, releasedAt: undefined, conclusion: undefined, amendmentReason: undefined }))
    };
    const patient = state.patients.find((entry) => entry.id === "patient-thor")!;
    const foreign: ClinicalArchiveRow[] = [{ requestId: "request-x", collection: "requests", entityKey: "request-x", position: 1, data: { id: "request-x", patientId: "patient-mel" }, archivedAt: RECENT, archiveBatch: "b" }];
    const headless: ClinicalArchiveRow[] = [{ requestId: "request-y", collection: "items", entityKey: "item-y", position: 1, data: { id: "item-y" }, archivedAt: RECENT, archiveBatch: "b" }];
    const exported = buildPatientDataExport(state, patient, [foreign, headless], RECENT);

    expect(exported.patient).not.toHaveProperty("birthDate");
    expect(exported.encounters).toEqual([{ externalId: "ATD-THOR-001", type: "INPATIENT", status: "CLOSED", openedAt: expect.any(String), closedAt: RECENT }]);
    expect(exported.admissions.every((admission) => admission.dischargedAt === RECENT)).toBe(true);
    // Same creation time: ordered by request code.
    expect(exported.requests.map((request) => request.requestCode)).toEqual(["EX-a", "EX-b"]);
    const retired = exported.requests[0].items[1];
    expect(retired).toEqual(expect.objectContaining({ service: { code: "service-retired", name: "service-retired" }, status: "CANCELLED", cancellationReason: "Desistência", rejectionReason: "Pedido duplicado" }));
    expect(retired).not.toHaveProperty("completedAt");
    expect(exported.requests[0].items[0].samples[0]).toEqual({ accessionCode: "ACC-A", sampleType: "EDTA", status: "RECEIVED" });
    for (const version of exported.requests[0].items[0].results[0].versions) {
      expect(Object.keys(version).sort()).toEqual(["content", "critical", "narrative", "sequence", "status"]);
    }
    expect(JSON.stringify(exported)).not.toContain("request-x");
  });

  it("reads a long archive a page at a time and exports all of it", async () => {
    const { store, service, user, reauthenticated } = await exportContext((state) => {
      let next = state;
      for (let index = 0; index < 205; index++) next = withCompletedRequest(next, `bulk-${index}`);
      return next;
    });
    const reads = vi.spyOn(store, "readClinicalArchive");
    const exported = await service.exportPatientData(await reauthenticated(user("ADMIN")), "HIS-THOR-001");
    expect(exported.requests.filter((request) => request.archived)).toHaveLength(206);
    expect(reads.mock.calls.map(([query]) => query.offset)).toEqual([0, 100, 200]);
  });
});
