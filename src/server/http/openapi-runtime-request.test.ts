import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  admissionContextSchema,
  attachmentUploadSchema,
  cancelSchema,
  resultDraftSchema,
  releaseResultSchema,
  scheduleSchema
} from "./command-schemas";

type JsonObject = Record<string, unknown>;

const document = JSON.parse(
  readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")
) as JsonObject;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(document, "cvg-openapi");

function validateRequest(schemaName: string, value: unknown): boolean {
  return ajv.validate({ $ref: `cvg-openapi#/components/schemas/${schemaName}` }, value) === true;
}

function operation(path: string, method: string): JsonObject {
  return ((document.paths as JsonObject)[path] as JsonObject)[method] as JsonObject;
}

describe("OpenAPI request schemas against runtime command parsing", () => {
  it("rejects whitespace-only normalized command text in both representations", () => {
    const checksum = "a".repeat(64);
    const cases = [
      { name: "CancelCommand", value: { reasonCode: " " }, runtime: cancelSchema },
      { name: "ResultDraftCommand", value: { narrative: " ", content: {} }, runtime: resultDraftSchema },
      {
        name: "AttachmentUploadSessionRequest",
        value: { filename: " ", mimeType: "application/pdf", sizeBytes: 1, checksum },
        runtime: attachmentUploadSchema
      }
    ] as const;

    for (const sample of cases) {
      expect(sample.runtime.safeParse(sample.value).success, `${sample.name} runtime`).toBe(false);
      expect(validateRequest(sample.name, sample.value), `${sample.name} OpenAPI`).toBe(false);
    }
  });

  it("counts normalized Unicode text in JSON Schema code points at runtime", () => {
    const cases = [
      { name: "CancelCommand", value: { reasonCode: "😀".repeat(31) }, runtime: cancelSchema },
      { name: "CancelCommand", value: { reasonCode: "OK", reason: "😀".repeat(251) }, runtime: cancelSchema },
      { name: "CancelCommand", value: { reasonCode: "OK", itemIds: ["😀".repeat(51)] }, runtime: cancelSchema },
      { name: "ResultDraftCommand", value: { narrative: "😀".repeat(10_001), content: {} }, runtime: resultDraftSchema },
      { name: "ResultDraftCommand", value: { narrative: "OK", conclusion: "😀".repeat(2_501), content: {} }, runtime: resultDraftSchema }
    ] as const;

    for (const sample of cases) {
      expect(validateRequest(sample.name, sample.value), `${sample.name} OpenAPI`).toBe(true);
      expect(sample.runtime.safeParse(sample.value).success, `${sample.name} runtime`).toBe(true);
    }
  });

  it("does not accept undocumented normalization for machine-readable fields", () => {
    const checksum = "a".repeat(64);
    const cases = [
      {
        name: "ScheduleCommand",
        value: { startsAt: " 2026-08-25T10:00:00.000Z", endsAt: "2026-08-25T11:00:00.000Z", resource: "RX-1" },
        runtime: scheduleSchema
      },
      {
        name: "AttachmentUploadSessionRequest",
        value: { filename: "report.pdf", mimeType: " APPLICATION/PDF ", sizeBytes: 1, checksum },
        runtime: attachmentUploadSchema
      },
      {
        name: "AttachmentUploadSessionRequest",
        value: { filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1, checksum: ` ${checksum} ` },
        runtime: attachmentUploadSchema
      }
    ] as const;

    for (const sample of cases) {
      expect(validateRequest(sample.name, sample.value), `${sample.name} OpenAPI`).toBe(false);
      expect(sample.runtime.safeParse(sample.value).success, `${sample.name} runtime`).toBe(false);
    }
  });

  it("models canonical query, header, and catalog constraints", () => {
    expect(validateRequest("DepartmentCode", "!!!"), "DepartmentCode punctuation").toBe(false);
    expect(validateRequest("ServiceIdentifier", " service-hemogram "), "padded service identifier").toBe(false);
    expect(validateRequest("DateTime", "2026-08-22T00:00:00Z"), "canonical date-time query").toBe(true);
    for (const value of ["2026-08-22", " 2026-08-22T00:00:00Z ", "2026-08-22t00:00:00z"]) {
      expect(validateRequest("DateTime", value), `non-canonical date-time query ${value}`).toBe(false);
    }
    expect(validateRequest("DateTime", `2026-01-01T00:00:00.${"1".repeat(90)}Z`), "overlong date-time query").toBe(false);
    expect(validateRequest("DiagnosticServiceCreate", {
      code: "!!",
      name: "Radiologia",
      category: "IMAGING",
      departmentCode: "RADIOLOGY",
      workflowType: "RADIOLOGY",
      requiresSample: false,
      requiresSchedule: true,
      allowsAttachment: true,
      resultSchema: "NARRATIVE",
      slaHours: { ROUTINE: 24, URGENT: 8, EMERGENCY: 2 }
    }), "service code grammar").toBe(false);
    expect(validateRequest("DiagnosticServiceCreate", {
      code: "LAB_TEST",
      name: "Laboratório",
      category: "LABORATORY",
      departmentCode: "LABORATORY",
      workflowType: "RADIOLOGY",
      requiresSample: true,
      requiresSchedule: false,
      allowsAttachment: false,
      resultSchema: "NUMERIC_PANEL",
      slaHours: { ROUTINE: 24, URGENT: 8, EMERGENCY: 2 }
    }), "service category/workflow compatibility").toBe(false);

    const cancel = operation("/diagnostic-requests/{requestId}/cancel", "post");
    const idempotency = (cancel.parameters as JsonObject[]).find((parameter) => parameter.name === "Idempotency-Key");
    expect(idempotency).toBeTruthy();
    const validateIdempotency = ajv.compile((idempotency as JsonObject).schema as AnySchema);
    expect(validateIdempotency(" "), "Idempotency-Key whitespace").toBe(false);

    const pathParameter = (operation("/patients/{patientId}", "get").parameters as JsonObject[]).find((parameter) => parameter.name === "patientId");
    const validatePathParameter = ajv.compile((pathParameter as JsonObject).schema as AnySchema);
    expect(validatePathParameter("foo/bar"), "decoded slash in path parameter").toBe(false);
  });

  it("rejects lowercase RFC3339 markers and blank request annotations consistently", () => {
    const lowercaseSchedule = { startsAt: "2026-01-01t00:00:00z", endsAt: "2026-01-01t01:00:00z", resource: "US-01" };
    expect(scheduleSchema.safeParse(lowercaseSchedule).success, "runtime lowercase date-time").toBe(false);
    expect(validateRequest("ScheduleCommand", lowercaseSchedule), "OpenAPI lowercase date-time").toBe(false);
    expect(validateRequest("DiagnosticRequestCreate", {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram", note: "   " }]
    }), "blank request note").toBe(false);
  });

  it("keeps optional release metadata aligned between runtime and OpenAPI", () => {
    expect(releaseResultSchema.safeParse({}).success, "runtime optional release metadata").toBe(true);
    expect(validateRequest("ReleaseResultCommand", {}), "OpenAPI optional release metadata").toBe(true);
    expect(releaseResultSchema.safeParse({ critical: true }).success).toBe(true);
    expect(validateRequest("ReleaseResultCommand", { critical: true })).toBe(true);
  });

  it("keeps admission context variants aligned and fail-closed against overposting", () => {
    const effectiveAt = "2026-09-05T12:00:00.000Z";
    const cases = [
      { action: "BED_CHANGE", effectiveAt, reason: "Leito aprovado", ward: "UTI 2", bed: "Box 04" },
      { action: "DISCHARGE", effectiveAt, reason: "Alta aprovada" },
      { action: "RESPONSIBILITY_CHANGE", effectiveAt, reason: "Escala aprovada", responsibleUserId: "user-vet" }
    ];
    for (const value of cases) {
      expect(admissionContextSchema.safeParse(value).success, `${value.action} runtime`).toBe(true);
      expect(validateRequest("AdmissionContextCommand", value), `${value.action} OpenAPI`).toBe(true);
    }

    const overposted = { action: "DISCHARGE", effectiveAt, reason: "Alta aprovada", ward: "indevido" };
    expect(admissionContextSchema.safeParse(overposted).success, "overposted runtime").toBe(false);
    expect(validateRequest("AdmissionContextCommand", overposted), "overposted OpenAPI").toBe(false);
  });

  it("rejects blank normalized text across every administrative and catalog request", () => {
    const managedUser = {
      email: "new-user@cvg.local",
      displayName: "Colaborador",
      password: "safe-password-123",
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Cobertura operacional",
      confirm: true
    };
    const service = {
      code: "LAB_TEST",
      name: "Laboratório",
      category: "LABORATORY",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      requiresSample: true,
      requiresSchedule: false,
      allowsAttachment: false,
      resultSchema: "NUMERIC_PANEL",
      slaHours: { ROUTINE: 24, URGENT: 8, EMERGENCY: 2 }
    };
    const cases = [
      ["ManagedUserCreate", { ...managedUser, displayName: " " }],
      ["ManagedUserCreate", { ...managedUser, reason: " " }],
      ["ManagedUserCreate", { ...managedUser, managedDepartmentCodes: [" "] }],
      ["ManagedUserDeactivate", { expectedVersion: 1, reason: " ", confirm: true }],
      ["UserRoleUpdate", { role: "LAB_TECH", departmentCode: "LABORATORY", expectedVersion: 1, reason: " ", confirm: true }],
      ["DiagnosticServiceCreate", { ...service, name: " " }],
      ["DiagnosticServicePatch", { name: " " }],
      ["DiagnosticServicePatch", { category: "IMAGING", workflowType: "LABORATORY" }],
      ["ReasonCodeCreate", { type: "CANCEL", code: "CLINICAL", label: " " }],
      ["ReasonCodePatch", { label: " " }]
    ] as const;

    for (const [schemaName, value] of cases) {
      expect(validateRequest(schemaName, value), `${schemaName} blank normalized text`).toBe(false);
    }
  });
});
