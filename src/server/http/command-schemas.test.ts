import { describe, expect, it } from "vitest";
import {
  acknowledgeNotificationSchema,
  admissionContextSchema,
  amendResultSchema,
  attachmentFinalizeSchema,
  attachmentUploadSchema,
  cancelSchema,
  emptyCommandSchema,
  recollectionSchema,
  releaseResultSchema,
  resultDraftSchema,
  reviewResultSchema,
  scheduleSchema,
  sampleSchema,
  voidResultSchema
} from "./command-schemas";

describe("strict command schemas", () => {
  it("rejects coercion-prone values and unknown keys", () => {
    expect(sampleSchema.safeParse({ accessionCode: {}, sampleType: "EDTA" }).success).toBe(false);
    // Scanned accession and type are optional (system-generated sample); a malformed code is still refused.
    expect(sampleSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
    expect(sampleSchema.safeParse({ accessionCode: "A261008-00015" }).success).toBe(true);
    expect(sampleSchema.safeParse({ accessionCode: "a261008-00015" }).success).toBe(false);
    expect(cancelSchema.safeParse({ reasonCode: "CLINICAL_DECISION", unexpected: true }).success).toBe(false);
    expect(scheduleSchema.safeParse({ startsAt: "2026-08-25T10:00:00.000Z", endsAt: "2026-08-25T10:30:00.000Z", resource: 42 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ startsAt: "tomorrow", endsAt: "later", resource: "RX-1" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ startsAt: "2026-08-25T10:00:00.000Z", endsAt: "2026-08-26T10:00:00.001Z", resource: "RX-1" }).success).toBe(false);
  });

  it("enforces bounded clinical text and structured result content", () => {
    expect(resultDraftSchema.safeParse({ narrative: "", content: {} }).success).toBe(false);
    expect(resultDraftSchema.safeParse({ narrative: "ok", content: "unsafe" }).success).toBe(false);
    expect(amendResultSchema.safeParse({ reason: "x", narrative: "y", content: {}, critical: "true" }).success).toBe(false);
    expect(resultDraftSchema.safeParse({
      narrative: "Painel preenchido.",
      content: {
        kind: "LABORATORY_STRUCTURED",
        panelCode: "SYNTHETIC_HEMOGRAM",
        panelVersion: 1,
        observations: [{ analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" }]
      }
    }).success).toBe(true);
    expect(resultDraftSchema.safeParse({
      narrative: "Painel preenchido.",
      content: {
        kind: "LABORATORY_STRUCTURED",
        panelCode: "SYNTHETIC_HEMOGRAM",
        panelVersion: 1,
        observations: [{ analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL", flag: "HIGH" }]
      }
    }).success).toBe(false);
  });

  it("keeps command metadata optional but typed", () => {
    expect(emptyCommandSchema.safeParse({}).success).toBe(true);
    expect(emptyCommandSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
    expect(emptyCommandSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(recollectionSchema.safeParse({ reasonCode: "HEMOLYZED", note: "ok", expectedVersion: 1 }).success).toBe(true);
    expect(reviewResultSchema.safeParse({ versionId: "version-1", expectedVersion: 1 }).success).toBe(true);
  });

  it("requires safe attachment metadata and rejects oversized inputs", () => {
    const valid = { filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 12, checksum: "a".repeat(64) };
    expect(attachmentUploadSchema.safeParse(valid).success).toBe(true);
    expect(attachmentUploadSchema.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false);
    expect(attachmentUploadSchema.safeParse({ ...valid, checksum: "not-a-checksum" }).success).toBe(false);
    expect(attachmentUploadSchema.safeParse({ ...valid, mimeType: "text/plain" }).success).toBe(false);
    expect(attachmentFinalizeSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(releaseResultSchema.safeParse({ critical: false }).success).toBe(true);
    expect(releaseResultSchema.safeParse({}).success).toBe(true);
    expect(voidResultSchema.safeParse({ reason: "Correção", expectedVersion: 1 }).success).toBe(true);
    expect(acknowledgeNotificationSchema.safeParse({}).success).toBe(false);
    expect(acknowledgeNotificationSchema.safeParse({ expectedVersion: 1, reason: "Confirmei o contexto", confirm: true }).success).toBe(true);
  });

  it("keeps admission context actions strict and action-specific", () => {
    const effectiveAt = "2026-09-05T12:00:00.000Z";
    expect(admissionContextSchema.safeParse({
      action: "TRANSFER",
      effectiveAt,
      reason: "Mudança autorizada",
      departmentCode: "INPATIENT",
      ward: "UTI 2",
      bed: "Box 04",
      responsibleUserId: "user-vet",
      expectedVersion: 1
    }).success).toBe(true);
    expect(admissionContextSchema.safeParse({ action: "TRANSFER", effectiveAt, reason: "Mudança autorizada" }).success).toBe(false);
    expect(admissionContextSchema.safeParse({ action: "DISCHARGE", effectiveAt, reason: "Alta autorizada", ward: "indevido" }).success).toBe(false);
    expect(admissionContextSchema.safeParse({ action: "RESPONSIBILITY_CHANGE", effectiveAt, reason: "Troca autorizada", responsibleUserId: " " }).success).toBe(false);
  });
});
