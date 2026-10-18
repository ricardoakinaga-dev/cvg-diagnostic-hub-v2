import { z } from "zod";
import * as resources from "../src/server/http/hospital-resource-schemas.ts";
import * as plans from "../src/server/http/hospital-plan-schemas.ts";
import * as checklists from "../src/server/http/hospital-checklist-schemas.ts";
import * as shifts from "../src/server/http/hospital-shift-schemas.ts";
import { hospitalCareExecuteSchema } from "../src/server/http/hospital-care-schemas.ts";
import { ROLES } from "../packages/contracts/src/identity-roles.ts";
import { PERMISSIONS } from "../packages/contracts/src/identity-permissions.ts";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max });
const id = str(100);
const date = { type: "string", format: "date-time" };
const integer = { type: "integer", minimum: 0 };
const revision = { type: "integer", minimum: 1 };
const bool = { type: "boolean" };
const array = (items) => ({ type: "array", items });
const enumeration = (...values) => ({ type: "string", enum: values });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const optionalObject = (properties, optional) => object(properties, Object.keys(properties).filter((key) => !optional.includes(key)));
const permissions = array(ref("Permission"));
const entityFields = { id, version: revision, createdAt: date, updatedAt: date };
const page = (items) => optionalObject({ items: array(items), total: integer, limit: revision, nextCursor: str(2000) }, ["nextCursor"]);
const inventoryPage = (items) => optionalObject({ items: array(items), total: integer, nextCursor: str(2000) }, ["nextCursor"]);

// Generate input structure from the same strict schemas used by HTTP handlers.
// Versioned commands also accept If-Match; cross-field and state rules remain enforced in the service.
function inputSchema(schema, constraints = []) {
  const converted = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "throw" });
  delete converted.$schema;
  if (converted.properties?.expectedVersion) converted.required = (converted.required ?? []).filter((key) => key !== "expectedVersion");
  if (constraints.length) converted["x-cross-field-constraints"] = constraints;
  return converted;
}
const reservationConstraints = ["startsAt must precede endsAt by at most 24 hours", "resourceIds must be unique, active, available and in the target department; BED uses Admission occupancy"];
export const hospitalPlanningRequestSchemas = {
  HospitalResourceCreate: inputSchema(resources.hospitalResourceCreateSchema, ["PROFESSIONAL requires userId; other kinds reject it", "BED requires ward, bedLabel and distinct compatible allowedSpecies, and rejects hourly windows", "non-BED rejects bed properties; window startsAt must precede endsAt"]),
  HospitalResourcePatch: inputSchema(resources.hospitalResourcePatchSchema, ["at least one metadata change is required", "identity is immutable; reservations and occupancy protect incompatible changes"]),
  HospitalTaskReserve: inputSchema(resources.hospitalTaskReserveSchema, reservationConstraints),
  HospitalScheduleReschedule: inputSchema(resources.hospitalScheduleRescheduleSchema, reservationConstraints),
  HospitalScheduleCancel: inputSchema(resources.hospitalScheduleCancelSchema),
  HospitalCareExecute: inputSchema(hospitalCareExecuteSchema, ["approved clinical process, eligible executor, current patient context and completed required checklist are required", "confirmation records the executor declaration and reference; it is not an external delivery receipt"]),
  HospitalPlanCreate: inputSchema(plans.hospitalPlanCreateSchema, ["distinct active departments, valid patient encounter and ordered planned dates are required", "step ids must be distinct"]),
  HospitalPlanPatch: inputSchema(plans.hospitalPlanPatchSchema, ["changes are limited to ACTIVE plans; at least one change is required"]),
  HospitalPlanLink: inputSchema(plans.hospitalPlanLinkSchema, ["both plan and linked activity require current access; clinical context and department must match", "linking or closing never changes the activity workflow"]),
  HospitalPlanCommand: inputSchema(plans.hospitalPlanCommandSchema),
  HospitalChecklistCreate: inputSchema(checklists.hospitalChecklistCreateSchema, ["step codes and executor roles must be distinct", "a clinical process requires careContextRequired and explicit adopted policy and clinical system references"]),
  HospitalChecklistPatch: inputSchema(checklists.hospitalChecklistPatchSchema, ["only DRAFT may be revised; used snapshots are immutable"]),
  HospitalChecklistApproval: inputSchema(checklists.hospitalChecklistApprovalSchema),
  HospitalChecklistStep: inputSchema(checklists.hospitalChecklistStepSchema, ["DONE requires evidence when prescribed by the captured step", "VOID requires a reason and authorized executor or management"]),
  HospitalRecurrenceCreate: inputSchema(checklists.hospitalRecurrenceCreateSchema, ["approved template, valid clinical context, eligible responsible professional and ordered interval are required"]),
  HospitalRecurrencePatch: inputSchema(checklists.hospitalRecurrencePatchSchema),
  HospitalRecurrenceGeneration: inputSchema(checklists.hospitalRecurrenceGenerationSchema, ["bounded catch-up advances a durable cursor and uses unique recurrenceId and occurrenceAt; it never executes clinical care"]),
  HospitalShiftCreate: inputSchema(shifts.hospitalShiftCreateSchema, ["startAt must precede endAt; intervals are half-open", "members must be distinct and active department members; replacement must refer to an eligible member"]),
  HospitalShiftPatch: inputSchema(shifts.hospitalShiftPatchSchema),
  HospitalActivityShift: inputSchema(shifts.hospitalActivityShiftSchema, ["expectedVersion belongs to the target activity, not the shift", "assignment requires current target access and does not grant patient access"]),
  HospitalHandoffOffer: inputSchema(shifts.hospitalHandoffOfferSchema, ["distinct targets and compatible shifts are required; offer retains existing responsibilities"]),
  HospitalHandoffDecision: inputSchema(shifts.hospitalHandoffDecisionSchema, ["ACCEPT requires the recipient and current eligibility; all target versions are checked atomically", "acceptance never changes workflow, SLA or critical alerts"])
};

const resourceKind = enumeration("PROFESSIONAL", "ROOM", "EQUIPMENT", "BED");
const calendarKind = enumeration("RESERVATION", "DEADLINE", "EXECUTION");
const targetType = enumeration("HOSPITAL_TASK", "DIAGNOSTIC_ITEM");
const clinicalProcess = object({ modality: enumeration("CARE", "PROCEDURE"), allowedExecutorRoles: array(ref("RoleCode")), clinicalSystemReference: str(500), confirmationPolicyReference: str(500) });
const checklistStep = object({ code: str(60), label: str(200), required: bool, evidenceRequired: bool });
const planStep = object({ id, title: str(200), sortOrder: integer });
const planLink = object({ id, stepId: id, targetType, targetId: id });
const handoffEntry = optionalObject({ targetType, targetId: id, expectedTargetVersion: revision, previousResponsibleUserId: id }, ["previousResponsibleUserId"]);
export const hospitalPlanningResponseSchemas = {
  AdmissionContextOptions: object({ departments: array(object({ code: str(60), name: str(120) })), eligibleResponsibles: array(object({ id, displayName: str(160), departmentCode: str(60) })) }),
  RoleCode: enumeration(...ROLES),
  Permission: enumeration(...PERMISSIONS),
  HospitalTaskAssignee: object({ id, displayName: str(160), role: ref("RoleCode"), departmentCode: str(60) }),
  HospitalPlannerOptions: object({ departments: array(object({ code: str(60), name: str(120) })), staff: array(ref("HospitalTaskAssignee")) }),
  HospitalPlannerOptionAction: enumeration("plan.create", "plan.update", "shift.manage", "handoff.offer", "recurrence.manage", "checklist_template.manage"),
  HospitalActivityShiftResult: optionalObject({ targetType, targetId: id, shiftId: id, version: revision }, ["shiftId"]),
  HospitalResourceKind: resourceKind,
  HospitalCalendarKinds: { ...array(calendarKind), maxItems: 3 },
  HospitalResourceWindow: object({ startsAt: date, endsAt: date }),
  HospitalResource: optionalObject({ ...entityFields, code: str(60), name: str(160), kind: resourceKind, departmentCode: str(60), userId: id, ward: str(100), bedLabel: str(100), allowedSpecies: array(str(60)), availability: enumeration("AVAILABLE", "BLOCKED", "MAINTENANCE"), availabilityWindows: array(ref("HospitalResourceWindow")), active: bool }, ["userId", "ward", "bedLabel", "allowedSpecies"]),
  HospitalResourceSnapshot: optionalObject({ resourceId: id, resourceVersion: revision, code: str(60), name: str(160), kind: resourceKind, departmentCode: str(60), userId: id, capturedAt: date }, ["userId"]),
  HospitalResourceOptions: object({ departments: array(object({ code: str(60), name: str(120) })), professionals: array(object({ id, displayName: str(160), departmentCode: str(60) })) }),
  HospitalResourcePage: inventoryPage(ref("HospitalResource")),
  HospitalSchedule: { ...optionalObject({ id, procedureId: id, hospitalTaskId: id, startsAt: date, endsAt: date, resource: str(500), resourceIds: array(id), resourceSnapshots: array(ref("HospitalResourceSnapshot")), status: enumeration("SCHEDULED", "CANCELLED", "COMPLETED"), reason: str(500), actorId: id, createdAt: date, version: revision }, ["procedureId", "hospitalTaskId", "resourceIds", "resourceSnapshots", "reason"]), "x-cross-field-constraints": ["exactly one of procedureId or hospitalTaskId is present", "legacy display resource text is never inferred as inventory identity"] },
  HospitalScheduleRescheduleResult: object({ schedule: ref("HospitalSchedule"), previousSchedule: ref("HospitalSchedule") }),
  HospitalCalendarEvent: optionalObject({ id, kind: calendarKind, targetType: enumeration("DIAGNOSTIC_ITEM", "HOSPITAL_TASK"), targetId: id, departmentCode: str(60), label: str(200), startsAt: date, endsAt: date, schedule: ref("HospitalSchedule"), dueAt: date, deepLink: str(500) }, ["endsAt", "schedule", "dueAt"]),
  HospitalCalendarPage: inventoryPage(ref("HospitalCalendarEvent")),
  HospitalBedCensusRow: optionalObject({ resource: ref("HospitalResource"), state: enumeration("AVAILABLE", "OCCUPIED", "RESTRICTED_OCCUPANCY", "UNRECONCILED", "BLOCKED", "MAINTENANCE", "INACTIVE"), occupancy: optionalObject({ admissionId: id, encounterId: id, patientId: id, patientName: str(200), admittedAt: date, responsibleUserId: id, version: revision, openDiagnosticItemCount: integer, openHospitalTaskCount: integer }, ["responsibleUserId"]) }, ["occupancy"]),
  HospitalBedCensus: object({ asOf: date, beds: array(ref("HospitalBedCensusRow")), unregisteredAdmissions: array(object({ admissionId: id, patientId: id, patientName: str(200), departmentCode: str(60), ward: str(100), bed: str(100), version: revision })), dischargedWithPendingWork: array(object({ admissionId: id, patientId: id, patientName: str(200), openDiagnosticItemCount: integer, openHospitalTaskCount: integer })) }),
  HospitalResourceCapacity: optionalObject({ resourceId: id, code: str(60), name: str(160), kind: resourceKind, departmentCode: str(60), unit: enumeration("MINUTES", "BEDS"), nominal: { type: ["number", "null"] }, reserved: { type: "number", minimum: 0 }, available: { type: ["number", "null"] }, unavailable: { type: ["number", "null"] }, availabilityKnown: bool, reason: enumeration("CALENDAR_NOT_CONFIGURED", "RESOURCE_UNAVAILABLE", "LEGACY_OCCUPANCY_NOT_LINKED", "EXECUTION_END_UNKNOWN") }, ["reason"]),
  HospitalCapacityView: object({ from: date, to: date, asOf: date, resources: array(ref("HospitalResourceCapacity")), authorizedLoad: object({ openDiagnosticItems: integer, overdueDiagnosticItems: integer, openHospitalTasks: integer, estimatedMinutes: { type: ["number", "null"] } }), sla: object({ source: { const: "REQUEST_CAPTURE", type: "string" }, unit: { const: "ELAPSED_HOURS", type: "string" }, calendarPausesDeadline: { const: false, type: "boolean" } }) }),
  HospitalCareExecution: optionalObject({ id, performedAt: date, performedBy: id, modality: enumeration("CARE", "PROCEDURE"), templateId: id, templateVersion: revision, approvedBy: id, approvedAt: date, clinicalRecordReference: str(500), clinicalSystemReference: str(500), confirmationPolicyReference: str(500), resourceSnapshots: array(ref("HospitalResourceSnapshot")), note: str(2000), recordEvidence: { const: "EXECUTOR_REFERENCE", type: "string" } }, ["note"]),
  HospitalClinicalProcess: clinicalProcess,
  HospitalChecklistTemplate: optionalObject({ ...entityFields, code: str(60), name: str(200), departmentCode: str(60), careContextRequired: bool, steps: array(checklistStep), clinicalProcess: ref("HospitalClinicalProcess"), status: enumeration("DRAFT", "APPROVED", "RETIRED"), approvedBy: id, approvedAt: date, createdBy: id }, ["clinicalProcess", "approvedBy", "approvedAt"]),
  HospitalChecklistSnapshot: optionalObject({ templateId: id, templateVersion: revision, code: str(60), name: str(200), departmentCode: str(60), careContextRequired: bool, steps: array(checklistStep), clinicalProcess: ref("HospitalClinicalProcess"), approvedBy: id, approvedAt: date, capturedAt: date }, ["clinicalProcess"]),
  HospitalChecklistExecution: optionalObject({ id, stepCode: str(60), actorId: id, executedAt: date, evidenceText: str(2000), status: enumeration("DONE", "VOIDED"), voidedBy: id, voidedAt: date, voidReason: str(500), version: revision }, ["evidenceText", "voidedBy", "voidedAt", "voidReason"]),
  HospitalChecklistTemplateView: object({ template: ref("HospitalChecklistTemplate"), permissions }),
  HospitalChecklistTemplatePage: page(ref("HospitalChecklistTemplateView")),
  HospitalRecurrence: optionalObject({ ...entityFields, templateId: id, departmentCode: str(60), patientId: id, encounterId: id, title: str(200), priority: ref("Priority"), responsibleUserId: id, startAt: date, intervalMinutes: revision, endAt: date, active: bool, nextOccurrenceAt: date, createdBy: id, lastError: str(2000) }, ["patientId", "encounterId", "responsibleUserId", "endAt", "lastError"]),
  HospitalRecurrenceView: object({ recurrence: ref("HospitalRecurrence"), permissions }),
  HospitalRecurrencePage: page(ref("HospitalRecurrenceView")),
  HospitalRecurrenceGenerationReport: object({ generated: integer, alreadyGenerated: integer, blocked: integer, pending: integer, asOf: date }),
  HospitalPlan: optionalObject({ documentSnapshots: array(ref("HospitalDocumentSnapshot")), ...entityFields, code: str(60), title: str(200), objective: str(4000), patientId: id, encounterId: id, departmentCodes: array(str(60)), responsibleUserId: id, plannedStartAt: date, plannedEndAt: date, steps: array(planStep), links: array(planLink), state: enumeration("ACTIVE", "CLOSED", "ARCHIVED"), createdBy: id, closedAt: date, closedBy: id, archivedAt: date, archivedBy: id }, ["documentSnapshots", "responsibleUserId", "plannedStartAt", "plannedEndAt", "closedAt", "closedBy", "archivedAt", "archivedBy"]),
  HospitalPlanActivity: optionalObject({ ...planLink.properties, label: str(200), phase: ref("HospitalTaskPhase"), status: str(60), departmentCode: str(60), responsibleUserId: id, blocked: bool }, ["responsibleUserId"]),
  HospitalPlanView: object({ plan: ref("HospitalPlan"), permissions, activities: array(ref("HospitalPlanActivity")), steps: array(object({ ...planStep.properties, visibleActivities: integer, completedActivities: integer, blockedActivities: integer, state: enumeration("NO_VISIBLE_ACTIVITIES", "PENDING", "BLOCKED", "IN_PROGRESS", "COMPLETED") })), summary: object({ visibleActivities: integer, completedActivities: integer, pendingActivities: integer, blockedActivities: integer, denominator: { const: "AUTHORIZED_UNIQUE_ACTIVITIES", type: "string" } }) }),
  HospitalPlanPage: page(ref("HospitalPlanView")),
  HospitalShift: object({ ...entityFields, code: str(60), name: str(200), departmentCode: str(60), startAt: date, endAt: date, members: array(optionalObject({ userId: id, replacesUserId: id }, ["replacesUserId"])), status: enumeration("PLANNED", "CLOSED", "ARCHIVED"), createdBy: id }),
  HospitalShiftView: object({ shift: ref("HospitalShift"), permissions, current: bool, coverage: array(ref("HospitalTaskAssignee")), workload: object({ visibleActivities: integer, completedActivities: integer, denominator: { const: "AUTHORIZED_UNIQUE_ACTIVITIES", type: "string" } }) }),
  HospitalShiftPage: page(ref("HospitalShiftView")),
  HospitalHandoff: optionalObject({ ...entityFields, fromShiftId: id, toShiftId: id, departmentCode: str(60), offeredBy: id, recipientUserId: id, state: enumeration("OFFERED", "ACCEPTED", "REJECTED"), entries: array(handoffEntry), offeredAt: date, acceptedAt: date, rejectedAt: date, reason: str(500), decidedBy: id }, ["acceptedAt", "rejectedAt", "reason", "decidedBy"]),
  HospitalHandoffView: object({ handoff: ref("HospitalHandoff"), permissions, activities: array(object({ ...handoffEntry.properties, label: str(200), status: str(60) }, [...handoffEntry.required, "label", "status"])) }),
  HospitalHandoffPage: page(ref("HospitalHandoffView")),
  HospitalPlanState: enumeration("ACTIVE", "CLOSED", "ARCHIVED"),
  HospitalShiftStatus: enumeration("PLANNED", "CLOSED", "ARCHIVED"),
  HospitalHandoffState: enumeration("OFFERED", "ACCEPTED", "REJECTED"),
  HospitalChecklistStatus: enumeration("DRAFT", "APPROVED", "RETIRED")
};
