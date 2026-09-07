import { describe, expect, it } from "vitest";
import { createDemoState } from "../fixtures";
import type { DiagnosticItem, DiagnosticRequest, Sample } from "../../domain/models";
import {
  assertReconciliationClean,
  assertRelationalCutoverAllowed,
  assessRelationalCutover,
  reconcileRelationalRequest,
  stableCutoverHash,
  type RelationalCutoverEvidence
} from "./cutover";
import { sampleItemLink } from "./sample-lineage";

const completeEvidence: RelationalCutoverEvidence = {
  schemaReady: true,
  backfillComplete: true,
  reconciliationClean: true,
  relationalReadReady: true,
  relationalWriteReady: true,
  transactionAtomic: true,
  rollbackVerified: true,
  operationalApproval: true
};

describe("relational cutover guard and reconciliation", () => {
  it("keeps snapshot and shadow modes available while relational authority is fail-closed", () => {
    expect(assessRelationalCutover("SNAPSHOT")).toEqual({ mode: "SNAPSHOT", allowed: true, missing: [] });
    expect(assessRelationalCutover("SHADOW")).toEqual({ mode: "SHADOW", allowed: true, missing: [] });
    const decision = assessRelationalCutover("RELATIONAL", { schemaReady: true });
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toContain("backfillComplete");
    expect(() => assertRelationalCutoverAllowed({ schemaReady: true })).toThrow(
      "POSTGRES_RELATIONAL_CUTOVER_NOT_READY:backfillComplete"
    );
  });

  it("accepts a complete evidence contract only as a future explicit decision", () => {
    expect(assessRelationalCutover("RELATIONAL", completeEvidence)).toEqual({
      mode: "RELATIONAL",
      allowed: true,
      missing: []
    });
    expect(() => assertRelationalCutoverAllowed(completeEvidence)).not.toThrow();
  });

  it("compares a request aggregate without returning clinical values in mismatch evidence", () => {
    const base = createDemoState("relational-cutover-password");
    const request: DiagnosticRequest = {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0001",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "REQUESTED",
      itemIds: [],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      version: 1
    };
    const state = { ...base, requests: [request] };
    const requestId = "request-with-hyphen";
    const relational = {
      request: { id: requestId },
      items: [],
      samples: [],
      sampleItemLinks: [],
      procedures: [],
      schedules: [],
      results: [],
      resultVersions: [],
      attachments: [],
      notifications: []
    };
    const report = reconcileRelationalRequest(state, requestId, relational);
    expect(report.sourceAuthority).toBe("SNAPSHOT");
    expect(report.targetAuthority).toBe("RELATIONAL");
    expect(report.mismatches.length).toBeGreaterThan(0);
    expect(report.mismatches[0]).toEqual(expect.objectContaining({ entity: "diagnostic_requests", field: expect.any(String) }));
    expect(JSON.stringify(report)).not.toContain("relational-cutover-password");
    expect(() => assertReconciliationClean(report)).toThrow("POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED");
  });

  it("normalizes equivalent empty aggregates deterministically", () => {
    const state = createDemoState("relational-cutover-empty-password");
    const requestId = "missing-request";
    const relational = {
      request: { id: requestId },
      items: [],
      samples: [],
      sampleItemLinks: [],
      procedures: [],
      schedules: [],
      results: [],
      resultVersions: [],
      attachments: [],
      notifications: []
    };
    const report = reconcileRelationalRequest(state, requestId, relational);
    expect(report.mismatches).toEqual([]);
    expect(report.sourceHash).toBe(report.targetHash);
    expect(() => assertReconciliationClean(report)).not.toThrow();
    expect(stableCutoverHash(undefined)).not.toBe(stableCutoverHash(null));
  });

  it("canonicalizes PostgreSQL timestamptz formatting without accepting invalid timestamps", () => {
    const base = createDemoState("relational-cutover-timestamp-password");
    const request: DiagnosticRequest = {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0003",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "REQUESTED",
      itemIds: [],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      version: 1
    };
    const state = { ...base, requests: [request] };
    const equivalent = {
      request: {
        id: request.id,
        request_code: request.requestCode,
        patient_id: request.patientId,
        encounter_id: request.encounterId,
        admission_id: null,
        requester_id: request.requesterId,
        requesting_department_id: request.requestingDepartmentCode,
        priority: request.priority,
        aggregate_status: request.aggregateStatus,
        created_at: "2026-09-04T12:00:00+00:00",
        updated_at: "2026-09-04T12:00:00+00:00",
        version: request.version
      },
      items: [], samples: [], sampleItemLinks: [], procedures: [], schedules: [],
      results: [], resultVersions: [], attachments: [], notifications: []
    };

    const report = reconcileRelationalRequest(state, request.id, equivalent);
    expect(report.mismatches).toEqual([]);
    expect(report.sourceHash).toBe(report.targetHash);

    const invalid = {
      ...equivalent,
      request: { ...equivalent.request, created_at: "not-a-timestamp" }
    };
    expect(reconcileRelationalRequest(state, request.id, invalid).mismatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "diagnostic_requests", field: "created_at" })])
    );
  });

  it("reconciles replacement status, reason, versions and derived links exactly", () => {
    const base = createDemoState("relational-cutover-sample-password");
    const request: DiagnosticRequest = {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0002",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "IN_PROGRESS",
      itemIds: ["item-with-hyphen"],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:30:00.000Z",
      version: 2
    };
    const item: DiagnosticItem = {
      id: "item-with-hyphen",
      requestId: request.id,
      serviceId: "service-with-hyphen",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      priority: "ROUTINE",
      status: "RECOLLECTION_REQUIRED",
      requestedAt: "2026-09-04T12:00:00.000Z",
      slaStartedAt: "2026-09-04T12:00:00.000Z",
      dueAt: "2026-09-04T20:00:00.000Z",
      slaPolicyVersion: 1,
      currentSampleId: "sample-replacement",
      version: 3
    };
    const replaced: Sample = {
      id: "sample-initial",
      requestId: request.id,
      accessionCode: "ACC-0001",
      sampleType: "EDTA",
      status: "REPLACED",
      rejectionCode: "HEMOLYZED",
      rejectionNote: "Amostra hemolisada",
      itemIds: [item.id],
      receivedAt: "2026-09-04T12:30:00.000Z",
      receivedBy: "user-with-hyphen",
      version: 2
    };
    const replacement: Sample = {
      id: "sample-replacement",
      requestId: request.id,
      accessionCode: "ACC-0002",
      sampleType: "EDTA",
      status: "RECEIVED",
      replacesSampleId: replaced.id,
      itemIds: [item.id],
      receivedAt: "2026-09-04T13:00:00.000Z",
      receivedBy: "user-with-hyphen",
      version: 2
    };
    const state = { ...base, requests: [request], items: [item], samples: [replaced, replacement] };
    const relational = {
      request: {
        id: request.id,
        request_code: request.requestCode,
        patient_id: request.patientId,
        encounter_id: request.encounterId,
        admission_id: null,
        requester_id: request.requesterId,
        requesting_department_id: request.requestingDepartmentCode,
        priority: request.priority,
        aggregate_status: request.aggregateStatus,
        created_at: request.createdAt,
        updated_at: request.updatedAt,
        version: request.version
      },
      items: [{
        id: item.id,
        request_id: item.requestId,
        service_id: item.serviceId,
        department_id: item.departmentCode,
        workflow_type: item.workflowType,
        priority: item.priority,
        status: item.status,
        note: null,
        requested_at: item.requestedAt,
        received_at: null,
        started_at: null,
        performed_at: null,
        released_at: null,
        reviewed_at: null,
        completed_at: null,
        sla_started_at: item.slaStartedAt,
        due_at: item.dueAt,
        sla_policy_version: item.slaPolicyVersion,
        current_result_id: null,
        current_sample_id: item.currentSampleId,
        procedure_id: null,
        version: item.version
      }],
      samples: [
        {
          id: replaced.id,
          request_id: replaced.requestId,
          accession_code: replaced.accessionCode,
          sample_type: replaced.sampleType,
          status: replaced.status,
          replaces_sample_id: null,
          rejection_reason_id: "reason-hemolyzed",
          rejection_note: replaced.rejectionNote,
          item_ids: [item.id],
          collected_at: null,
          received_at: replaced.receivedAt,
          received_by: replaced.receivedBy,
          version: replaced.version
        },
        {
          id: replacement.id,
          request_id: replacement.requestId,
          accession_code: replacement.accessionCode,
          sample_type: replacement.sampleType,
          status: replacement.status,
          replaces_sample_id: replaced.id,
          rejection_reason_id: null,
          rejection_note: null,
          item_ids: [item.id],
          collected_at: null,
          received_at: replacement.receivedAt,
          received_by: replacement.receivedBy,
          version: replacement.version
        }
      ],
      sampleItemLinks: [sampleItemLink(replaced, item), sampleItemLink(replacement, item)],
      procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };

    const report = reconcileRelationalRequest(state, request.id, relational);
    expect(report.mismatches).toEqual([]);

    const diverged = {
      ...relational,
      sampleItemLinks: [
        { ...sampleItemLink(replaced, item), link_status: "ACTIVE" },
        sampleItemLink(replacement, item)
      ]
    };
    const divergence = reconcileRelationalRequest(state, request.id, diverged);
    expect(divergence.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: "sample_item_links", field: "link_status" })
    ]));
  });
});
