import { describe, expect, it } from "vitest";
import { diagnosticPlannerPhase, matchesDiagnosticPlannerFilters, type DiagnosticPlannerFilterItem } from "./index";

const item: DiagnosticPlannerFilterItem = { departmentCode: "LABORATORY", status: "REQUESTED", priority: "URGENT", assignedUserId: "clinician", plannedStartsAt: "2026-10-12T00:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z" };
describe("saved diagnostic filters across hospital surfaces", () => {
  it("uses the assigned professional and planned instant with inclusive boundaries, independently of civil timezone", () => {
    expect(matchesDiagnosticPlannerFilters(item, { responsibleUserId: "clinician", departmentCode: "LABORATORY", priority: "URGENT", phase: "PENDING", from: "2026-10-11T21:00:00-03:00", to: "2026-10-12T09:00:00+09:00" })).toBe(true);
    expect(matchesDiagnosticPlannerFilters(item, { responsibleUserId: "author" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { departmentCode: "RADIOLOGY" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { priority: "EMERGENCY" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { from: "2026-10-12T00:00:00.001Z" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { to: "2026-10-11T23:59:59.999Z" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters({ ...item, plannedStartsAt: undefined }, { from: item.createdAt, to: item.createdAt })).toBe(true);
  });
  it("does not turn a task type or a saved plan identifier into diagnostic access", () => {
    expect(matchesDiagnosticPlannerFilters(item, { typeId: "hospital-care" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { planId: "plan" })).toBe(false);
    expect(matchesDiagnosticPlannerFilters(item, { planId: "plan" }, true)).toBe(true);
    expect(matchesDiagnosticPlannerFilters(item, {})).toBe(true);
  });
  it("groups native states for read filters while preserving each diagnostic state", () => {
    for (const status of ["IN_PROGRESS", "AWAITING_REPORT", "RESULT_AVAILABLE", "REVIEWED"] as const) {
      const diagnostic = { ...item, status };
      expect(diagnosticPlannerPhase(status)).toBe("IN_PROGRESS");
      expect(matchesDiagnosticPlannerFilters(diagnostic, { phase: "IN_PROGRESS" })).toBe(true);
      expect(matchesDiagnosticPlannerFilters(diagnostic, { phase: "PENDING" })).toBe(false);
      expect(diagnostic.status).toBe(status);
    }
    expect(diagnosticPlannerPhase("CANCELLED")).toBe("CANCELLED");
    expect(diagnosticPlannerPhase("REJECTED")).toBe("CANCELLED");
    expect(diagnosticPlannerPhase("COMPLETED")).toBe("COMPLETED");
    expect(diagnosticPlannerPhase("RECOLLECTION_REQUIRED")).toBe("PENDING");
    expect(diagnosticPlannerPhase("RESULT_VOIDED")).toBe("PENDING");
  });
});
