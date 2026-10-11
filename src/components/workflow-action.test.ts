import { describe, expect, it } from "vitest";
import type { ItemState, WorkflowType } from "@cvg/contracts";
import { apiDateTime, secondaryWorkflowActionFor, workflowActionFor } from "./workflow-action";

const item = (status: ItemState, workflowType: WorkflowType, currentResultId?: string, currentSampleId?: string) => ({ id: "item-1", version: 1, status, workflowType, currentResultId, currentSampleId });

describe("workflow action mapping", () => {
  it("maps the next executable action by workflow capability", () => {
    expect(workflowActionFor(item("REQUESTED", "LABORATORY"))).toBe("RECEIVE_SAMPLE");
    expect(workflowActionFor(item("FAILED", "LABORATORY"))).toBe("RECEIVE_SAMPLE");
    expect(workflowActionFor(item("REQUESTED", "RADIOLOGY"))).toBe("START_PROCEDURE");
    expect(workflowActionFor(item("REQUESTED", "ULTRASOUND"))).toBe("SCHEDULE");
    expect(workflowActionFor(item("RECEIVED", "LABORATORY"))).toBe("START_PROCESSING");
    expect(workflowActionFor(item("AWAITING_REPORT", "RADIOLOGY"))).toBe("CREATE_RESULT");
  });

  it("keeps review and replacement actions contextual", () => {
    expect(workflowActionFor(item("RESULT_AVAILABLE", "LABORATORY", "result-1"))).toBe("REVIEW_RESULT");
    expect(workflowActionFor(item("RECOLLECTION_REQUIRED", "LABORATORY", undefined, "sample-expected"))).toBe("RECEIVE_REPLACEMENT");
    expect(workflowActionFor(item("RECOLLECTION_REQUIRED", "LABORATORY"))).toBeUndefined();
    expect(workflowActionFor(item("COMPLETED", "LABORATORY"))).toBeUndefined();
    expect(workflowActionFor(item("IN_PROGRESS", "LABORATORY", "draft-1"))).toBe("EDIT_RESULT");
    expect(workflowActionFor(item("AWAITING_REPORT", "RADIOLOGY", "draft-2"))).toBe("EDIT_RESULT");
    expect(workflowActionFor(item("RESULT_VOIDED", "ULTRASOUND", "voided-3"))).toBe("CREATE_RESULT");
  });

  it("exposes safe secondary actions and sends local date input as an offset datetime", () => {
    expect(secondaryWorkflowActionFor({ ...item("IN_PROGRESS", "LABORATORY", undefined, "sample-1") })).toBe("REQUEST_RECOLLECTION");
    expect(secondaryWorkflowActionFor({ ...item("SCHEDULED", "ULTRASOUND"), procedureId: "procedure-1", procedureVersion: 3 })).toBe("RESCHEDULE");
    expect(apiDateTime("2026-08-25T10:30")).toMatch(/2026-08-25T13:30:00\.000Z|2026-08-25T10:30:00\.000Z/);
    expect(() => apiDateTime("not-a-date")).toThrow();
  });
});
