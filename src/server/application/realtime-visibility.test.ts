import { describe, expect, it } from "vitest";
import type { Attachment, DiagnosticItem, DiagnosticRequest, Procedure, Result, ResultVersion, Sample } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { eventVisible } from "./realtime-visibility";

describe("realtime event visibility", () => {
  it("resolves every supported aggregate through the authorized patient item", () => {
    const state = createDemoState("realtime-visibility-password");
    const request: DiagnosticRequest = {
      id: "request-visibility",
      requestCode: "EX-260905-0001",
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      requesterId: "user-vet",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "IN_PROGRESS",
      itemIds: ["item-visibility"],
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:00.000Z",
      version: 1
    };
    const item: DiagnosticItem = {
      id: "item-visibility",
      requestId: request.id,
      serviceId: "service-hemogram",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      priority: "ROUTINE",
      status: "REQUESTED",
      requestedAt: request.createdAt,
      slaStartedAt: request.createdAt,
      dueAt: "2026-09-05T18:00:00.000Z",
      slaPolicyVersion: 1,
      version: 1,
      currentSampleId: "sample-visibility",
      currentResultId: "result-visibility",
      procedureId: "procedure-visibility"
    };
    const sample: Sample = {
      id: "sample-visibility",
      requestId: request.id,
      accessionCode: "ACC-VISIBILITY",
      sampleType: "BLOOD",
      status: "EXPECTED",
      itemIds: [item.id],
      version: 1
    };
    const procedure: Procedure = {
      id: "procedure-visibility",
      itemId: item.id,
      workflowType: "RADIOLOGY",
      status: "EXPECTED",
      scheduleIds: [],
      version: 1
    };
    const result: Result = {
      id: "result-visibility",
      itemId: item.id,
      currentVersionId: "result-version-visibility",
      lifecycleStatus: "DRAFT",
      needsReReview: false,
      version: 1
    };
    const resultVersion: ResultVersion = {
      id: "result-version-visibility",
      resultId: result.id,
      sequence: 1,
      status: "DRAFT",
      content: {},
      narrative: "Rascunho",
      authorId: "user-vet",
      createdAt: request.createdAt,
      critical: false,
      needsReReview: false,
      version: 1
    };
    const attachment: Attachment = {
      id: "attachment-visibility",
      resultVersionId: resultVersion.id,
      safeName: "laudo.pdf",
      storageKey: "attachments/visibility/laudo.pdf",
      detectedMime: "application/pdf",
      sizeBytes: 100,
      checksum: "checksum",
      scanStatus: "CLEAN",
      uploadStatus: "FINALIZED",
      createdBy: "user-vet",
      createdAt: request.createdAt
    };
    state.requests = [request];
    state.items = [item];
    state.samples = [sample];
    state.procedures = [procedure];
    state.results = [result];
    state.resultVersions = [resultVersion];
    state.attachments = [attachment];
    const actor = state.users.find((user) => user.id === "user-vet")!;

    expect(eventVisible(state, actor, "DiagnosticRequest", request.id, {})).toBe(true);
    expect(eventVisible(state, actor, "DiagnosticRequestItem", item.id, {})).toBe(true);
    expect(eventVisible(state, actor, "Sample", sample.id, {})).toBe(true);
    expect(eventVisible(state, actor, "Result", result.id, {})).toBe(true);
    expect(eventVisible(state, actor, "Procedure", procedure.id, {})).toBe(true);
    expect(eventVisible(state, actor, "Attachment", attachment.id, {})).toBe(true);
    expect(eventVisible(state, actor, "ResultVersion", resultVersion.id, {})).toBe(true);
  });

  it("hides missing or unsupported aggregates instead of leaking identifiers", () => {
    const state = createDemoState("realtime-visibility-negative-password");
    const actor = state.users.find((user) => user.id === "user-vet")!;

    for (const entityType of ["Sample", "Procedure", "Attachment", "ResultVersion", "UnknownAggregate"]) {
      expect(eventVisible(state, actor, entityType, "missing-id", {})).toBe(false);
    }
  });
});
