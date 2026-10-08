import { describe, expect, it } from "vitest";
import type { Admission, Attachment, Encounter, User } from "../domain/models";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function userByEmail(users: User[], email: string): User {
  const user = users.find((entry) => entry.email === email);
  if (!user) throw new Error(`fixture actor missing: ${email}`);
  return user;
}

describe("patient workspace projection", () => {
  it("joins patient context, operational items, sample, released result and clean attachment metadata", async () => {
    const store = new MemoryStore(createDemoState("workspace-complete-password"));
    const service = createApplicationService(store);
    const vet = userByEmail(store.getState().users, "vet@cvg.local");
    const lab = userByEmail(store.getState().users, "lab@cvg.local");
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "URGENT",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "workspace-complete-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], {
      sampleType: "EDTA",
      expectedVersion: request.items[0].version,
      idempotencyKey: "workspace-complete-receive"
    });
    const started = await service.startProcessing(lab, request.items[0].id, {
      expectedVersion: received.items[0].version,
      idempotencyKey: "workspace-complete-start"
    });
    const draft = await service.createResultDraft(lab, request.items[0].id, {
      narrative: "Resultado de workspace",
      content: syntheticHemogramContent(),
      expectedVersion: started.item.version,
      idempotencyKey: "workspace-complete-draft"
    });
    const released = await service.releaseResult(lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "workspace-complete-release"
    });
    const cleanAttachment: Attachment = {
      id: "attachment-workspace-clean",
      resultVersionId: released.version.id,
      safeName: "laudo.pdf",
      storageKey: "private/workspace/laudo.pdf",
      detectedMime: "application/pdf",
      sizeBytes: 2048,
      checksum: "a".repeat(64),
      scanStatus: "CLEAN",
      uploadStatus: "FINALIZED",
      createdBy: lab.id,
      createdAt: new Date().toISOString()
    };
    await store.transaction((state) => ({
      state: {
        ...state,
        attachments: [
          ...state.attachments,
          cleanAttachment,
          { ...cleanAttachment, id: "attachment-workspace-pending", scanStatus: "PENDING", uploadStatus: "UPLOADED" },
          { ...cleanAttachment, id: "attachment-workspace-quarantined", scanStatus: "QUARANTINED" }
        ]
      },
      result: undefined
    }));

    const workspace = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 50 });
    const hemogram = workspace.items[0].items.find((item) => item.id === request.items[0].id);
    if (!hemogram) throw new Error("hemogram workspace item missing");

    expect(workspace.workspace).toMatchObject({
      dataQuality: { status: "FRESH", asOf: workspace.workspace.asOf },
      currentContext: {
        encounterId: "encounter-thor",
        admissionId: "admission-thor",
        departmentCode: "INPATIENT",
        ward: "UTI 1",
        bed: "Box 03",
        responsibleLabel: null
      },
      summary: {
        requestCount: 1,
        itemCount: 2,
        activeItemCount: 2,
        availableResultCount: 1,
        sampleCount: 1,
        attachmentCount: 1
      }
    });
    expect(hemogram.workspaceContext).toMatchObject({
      operationalContext: { nextAction: { label: "Revisar resultado" } },
      sample: { id: received.sample.id, accessionCode: received.sample.accessionCode, status: "RECEIVED" },
      result: { id: released.result.id, versionId: released.version.id, status: "RELEASED" },
      attachments: [{ id: cleanAttachment.id, safeName: "laudo.pdf", scanStatus: "CLEAN", uploadStatus: "FINALIZED" }]
    });
    expect(hemogram.workspaceContext.attachments[0]).not.toHaveProperty("storageKey");
    expect(hemogram.workspaceContext.attachments[0]).not.toHaveProperty("checksum");

    await service.voidResult(lab, released.result.id, {
      reason: "Invalidar para validar a remoção da projeção liberada.",
      expectedVersion: released.result.version,
      idempotencyKey: "workspace-complete-void"
    });
    const voidedWorkspace = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 50 });
    const voidedHemogram = voidedWorkspace.items[0].items.find((item) => item.id === request.items[0].id);
    expect(voidedHemogram?.workspaceContext.result).toBeNull();
    expect(voidedHemogram?.workspaceContext.attachments).toEqual([]);
  });

  it("filters the same workspace by actor scope and does not expose draft or foreign patient context", async () => {
    const store = new MemoryStore(createDemoState("workspace-scope-password"));
    const service = createApplicationService(store);
    const vet = userByEmail(store.getState().users, "vet@cvg.local");
    const lab = userByEmail(store.getState().users, "lab@cvg.local");
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "workspace-scope-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], {
      sampleType: "EDTA",
      expectedVersion: request.items[0].version,
      idempotencyKey: "workspace-scope-receive"
    });
    const started = await service.startProcessing(lab, request.items[0].id, {
      expectedVersion: received.items[0].version,
      idempotencyKey: "workspace-scope-start"
    });
    await service.createResultDraft(lab, request.items[0].id, {
      narrative: "Draft privado",
      content: syntheticHemogramContent(),
      expectedVersion: started.item.version,
      idempotencyKey: "workspace-scope-draft"
    });
    const hiddenEncounter: Encounter = {
      id: "encounter-thor-hidden",
      patientId: "patient-thor",
      externalId: "ATD-THOR-HIDDEN",
      type: "EMERGENCY",
      status: "OPEN",
      openedAt: "2026-08-20T12:00:00.000Z"
    };
    const hiddenAdmission: Admission = {
      id: "admission-thor-hidden",
      encounterId: hiddenEncounter.id,
      departmentCode: "RADIOLOGY",
      ward: "Imagem",
      bed: "Sala 2",
      admittedAt: hiddenEncounter.openedAt,
      version: 1
    };
    const hiddenSameEncounterAdmission: Admission = {
      id: "admission-thor-radiology",
      encounterId: "encounter-thor",
      departmentCode: "RADIOLOGY",
      ward: "Imagem",
      bed: "Sala 2",
      admittedAt: "2026-08-20T12:00:00.000Z",
      version: 1
    };
    await store.transaction((state) => ({
      state: {
        ...state,
        encounters: [...state.encounters, hiddenEncounter],
        admissions: [...state.admissions, hiddenAdmission, hiddenSameEncounterAdmission]
      },
      result: undefined
    }));

    const labWorkspace = await service.getPatientDiagnostics(lab, "patient-thor", { limit: 50 });
    expect(labWorkspace.items).toHaveLength(1);
    expect(labWorkspace.items[0].items).toHaveLength(1);
    expect(labWorkspace.encounters).toEqual([expect.objectContaining({ id: "encounter-thor" })]);
    expect(labWorkspace.admissions).toEqual([]);
    await expect(service.getAdmission(lab, "admission-thor")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.getAdmission(lab, hiddenSameEncounterAdmission.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    expect(labWorkspace.items[0].items[0].service.name).toBe("Hemograma");
    expect(labWorkspace.items[0].items[0].workspaceContext.result).toBeNull();
    expect(labWorkspace.items[0].items[0].workspaceContext.attachments).toEqual([]);
    expect(labWorkspace.workspace.summary).toMatchObject({ requestCount: 1, itemCount: 1, availableResultCount: 0, sampleCount: 1 });
    await expect(service.getPatientDiagnostics(lab, "patient-mel", { limit: 50 })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.getPatientDiagnostics(lab, "patient-does-not-exist", { limit: 50 })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("keeps the current encounter and admission context aligned", async () => {
    const store = new MemoryStore(createDemoState("workspace-context-password"));
    const service = createApplicationService(store);
    const vet = userByEmail(store.getState().users, "vet@cvg.local");
    const currentEncounter: Encounter = {
      id: "encounter-thor-current",
      patientId: "patient-thor",
      externalId: "ATD-THOR-CURRENT",
      type: "EMERGENCY",
      status: "OPEN",
      openedAt: "2026-12-31T12:00:00.000Z"
    };
    await store.transaction((state) => ({
      state: { ...state, encounters: [...state.encounters, currentEncounter] },
      result: undefined
    }));

    const workspace = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 50 });

    expect(workspace.workspace.currentContext).toMatchObject({
      encounterId: currentEncounter.id,
      admissionId: null,
      departmentCode: null,
      ward: null,
      bed: null,
      responsibleLabel: null
    });
  });

  it("does not project an admission responsible identity outside the actor's scope", async () => {
    const store = new MemoryStore(createDemoState("workspace-responsible-password"));
    const service = createApplicationService(store);
    const vet = userByEmail(store.getState().users, "vet@cvg.local");
    const lab = userByEmail(store.getState().users, "lab@cvg.local");
    await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "workspace-responsible-request" });
    await store.transaction((state) => ({
      state: {
        ...state,
        admissions: state.admissions.map((admission) => admission.id === "admission-thor" ? { ...admission, responsibleUserId: vet.id } : admission)
      },
      result: undefined
    }));

    const labWorkspace = await service.getPatientDiagnostics(lab, "patient-thor", { limit: 50 });
    const vetWorkspace = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 50 });

    expect(labWorkspace.workspace.currentContext.responsibleLabel).toBeNull();
    expect(vetWorkspace.workspace.currentContext.responsibleLabel).toBe(vet.displayName);
  });

  it("marks the workspace degraded when the auxiliary read boundary fails", async () => {
    const store = new MemoryStore(createDemoState("workspace-degraded-password"));
    const service = createApplicationService(store, {
      patientDiagnosticsAuxiliaryReader: () => {
        throw new Error("AUXILIARY_READ_UNAVAILABLE");
      }
    });
    const vet = userByEmail(store.getState().users, "vet@cvg.local");
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "workspace-degraded-request" });

    const workspace = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 50 });
    const item = workspace.items[0].items.find((entry) => entry.id === request.items[0].id);

    expect(workspace.workspace.dataQuality).toMatchObject({ status: "DEGRADED", asOf: workspace.workspace.asOf });
    expect(workspace.workspace.dataQuality.note).toContain("leitura auxiliar");
    expect(workspace.workspace.summary).toMatchObject({ availableResultCount: 0, sampleCount: 0, attachmentCount: 0 });
    expect(item?.workspaceContext).toMatchObject({ sample: null, result: null, attachments: [] });
  });
});
