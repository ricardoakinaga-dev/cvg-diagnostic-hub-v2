import { describe, expect, it } from "vitest";
import { deriveOperationalContext } from "./index";

const baseInput = {
  workflowType: "LABORATORY" as const,
  priority: "ROUTINE" as const,
  departmentCode: "LABORATORY",
  requestingDepartmentCode: "INPATIENT",
  requiresSample: true,
  requiresSchedule: false,
  requestedAt: "2026-08-25T08:00:00.000Z",
  dueAt: "2026-08-25T12:00:00.000Z",
  asOf: "2026-08-25T09:00:00.000Z"
};

describe("deriveOperationalContext", () => {
  it("makes a requested laboratory sample explicitly wait on the requesting team", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "REQUESTED" })).toEqual({
      currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante · Internação" },
      nextAction: { code: "COLLECT_SAMPLE", label: "Receber amostra" },
      blockedBy: { code: "WAITING_SAMPLE", label: "Aguardando amostra" },
      waitingSince: "2026-08-25T08:00:00.000Z",
      expectedBy: "2026-08-25T12:00:00.000Z",
      escalationLevel: "NONE"
    });
  });

  it("distinguishes an overdue emergency from a routine item", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "IN_PROGRESS", priority: "EMERGENCY", dueAt: "2026-08-25T08:30:00.000Z" })).toMatchObject({
      currentOwner: { code: "LABORATORY" },
      nextAction: { code: "REGISTER_RESULT" },
      escalationLevel: "URGENT",
      blockedBy: null
    });
  });

  it("does not invent a blocker for a released result awaiting review", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "RESULT_AVAILABLE", requiresSample: false, releasedAt: "2026-08-25T08:45:00.000Z" })).toMatchObject({
      currentOwner: { code: "REQUESTING_TEAM" },
      nextAction: { code: "REVIEW_RESULT", label: "Revisar resultado" },
      blockedBy: null,
      waitingSince: null
    });
  });

  it("fails safely to a technical owner and a watch level for unknown department data", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "FAILED", departmentCode: "", dueAt: "not-a-date" })).toMatchObject({
      currentOwner: { code: "UNKNOWN", label: "A definir" },
      nextAction: { code: "MONITOR_ITEM" },
      expectedBy: null,
      escalationLevel: "WATCH"
    });
  });

  it("does not expose an unknown requesting department code in operator copy", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "REQUESTED", requestingDepartmentCode: "INTERNAL_DEPARTMENT_CODE" })).toMatchObject({
      currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante" }
    });
  });

  it("derives the remaining workflow actions, blockers and escalation levels", () => {
    expect(deriveOperationalContext({ ...baseInput, status: "REQUESTED", requiresSample: false, requiresSchedule: true })).toMatchObject({
      nextAction: { code: "SCHEDULE_EXAM" },
      blockedBy: { code: "WAITING_SCHEDULE" },
      currentOwner: { code: "LABORATORY" }
    });
    expect(deriveOperationalContext({ ...baseInput, status: "REQUESTED", requiresSample: false, requiresSchedule: false })).toMatchObject({
      nextAction: { code: "ROUTE_PATIENT" },
      blockedBy: null,
      currentOwner: { code: "LABORATORY" }
    });
    expect(deriveOperationalContext({ ...baseInput, status: "RECEIVED", requiresSample: false })).toMatchObject({ nextAction: { code: "START_PROCESSING" } });
    expect(deriveOperationalContext({ ...baseInput, status: "IN_PROGRESS", workflowType: "RADIOLOGY", requiresSample: false })).toMatchObject({ nextAction: { code: "MARK_PERFORMED" } });
    expect(deriveOperationalContext({ ...baseInput, status: "AWAITING_REPORT", requiresSample: false, performedAt: "invalid", startedAt: "2026-08-25T10:00:00.000Z" })).toMatchObject({
      nextAction: { code: "PRODUCE_REPORT" },
      blockedBy: { code: "WAITING_REPORT" },
      waitingSince: "2026-08-25T10:00:00.000Z"
    });
    expect(deriveOperationalContext({ ...baseInput, status: "RECOLLECTION_REQUIRED", requiresSample: false })).toMatchObject({
      nextAction: { code: "COLLECT_REPLACEMENT_SAMPLE" },
      blockedBy: { code: "WAITING_REPLACEMENT_SAMPLE" },
      currentOwner: { code: "REQUESTING_TEAM" }
    });
    expect(deriveOperationalContext({ ...baseInput, status: "COMPLETED", requiresSample: false, requestingDepartmentCode: undefined })).toMatchObject({
      nextAction: { code: "MONITOR_ITEM" },
      currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante" },
      escalationLevel: "NONE"
    });
    expect(deriveOperationalContext({ ...baseInput, status: "IN_PROGRESS", requiresSample: false, priority: "EMERGENCY", dueAt: "2026-08-25T12:00:00.000Z" })).toMatchObject({ escalationLevel: "ATTENTION" });
  });
});
