import type { WorkActivityReference, WorkActivityTargetType } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource } from "../security/authorization";
import { findOrThrowScoped, requireActiveUser, requireItemPermission, requirePermission, requireRequestPermission } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { requireHospitalPlanAccess } from "./hospital-plan-policy";
import { requireChecklistTemplateAccess } from "./hospital-checklist-policy";
import { requireHospitalDocumentAccess } from "./hospital-document-policy";
import { requireHospitalResourceAccess } from "./hospital-resource-policy";

/** Preferences and inbox references never supply grants to their underlying authority. */
export function resolveWorkActivity(state: StoreState, actor: User, targetType: WorkActivityTargetType, targetId: string): WorkActivityReference {
  actor = requireActiveUser(state, actor);
  const reference = (label: string, deepLink: string): WorkActivityReference => ({ targetType, targetId, label, deepLink });
  switch (targetType) {
    case "HOSPITAL_TASK": { const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === targetId && !entry.archivedAt && !entry.draftCancelledAt)); requireHospitalTaskAccess(state, actor, "hospital_task.view", task); return reference(`${task.taskCode} · ${task.title}`, `/planner/tasks/${task.id}`); }
    case "HOSPITAL_PLAN": { const plan = findOrThrowScoped(state.hospitalPlans.find((entry) => entry.id === targetId)); requireHospitalPlanAccess(state, actor, "plan.view", plan); return reference(`${plan.code} · ${plan.title}`, `/planner/plans/${plan.id}`); }
    case "HOSPITAL_SHIFT": { const shift = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === targetId)); requireHospitalTaskAccess(state, actor, "shift.view", shift); return reference(`${shift.code} · ${shift.name}`, `/planner/shifts/${shift.id}`); }
    case "HOSPITAL_HANDOFF": { const handoff = findOrThrowScoped(state.hospitalHandoffs.find((entry) => entry.id === targetId)); requireHospitalTaskAccess(state, actor, "shift.view", handoff); return reference("Passagem de plantão", `/planner/handoffs?handoffId=${handoff.id}`); }
    case "HOSPITAL_INTAKE": { const intake = findOrThrowScoped(state.hospitalIntakes.find((entry) => entry.id === targetId)); requireHospitalTaskAccess(state, actor, "hospital_intake.view", intake); return reference(intake.title, `/planner/intake?intakeId=${intake.id}`); }
    case "CHECKLIST_TEMPLATE": { const template = findOrThrowScoped(state.hospitalChecklistTemplates.find((entry) => entry.id === targetId)); requireChecklistTemplateAccess(state, actor, "checklist_template.view", template); return reference(`${template.code} · ${template.name}`, `/planner/checklists?templateId=${template.id}`); }
    case "HOSPITAL_RECURRENCE": { const recurrence = findOrThrowScoped(state.hospitalRecurrences.find((entry) => entry.id === targetId)); requireHospitalTaskAccess(state, actor, "recurrence.view", recurrence); return reference(recurrence.title, `/planner/recurrences?recurrenceId=${recurrence.id}`); }
    case "HOSPITAL_DOCUMENT": { const document = findOrThrowScoped(state.hospitalDocuments.find((entry) => entry.id === targetId)); requireHospitalDocumentAccess(actor, "hospital_document.view", document.departmentCode); return reference(`${document.code} · ${document.title}`, `/planner/documents/${document.id}`); }
    case "HOSPITAL_RESOURCE": { const resource = findOrThrowScoped(state.hospitalResources.find((entry) => entry.id === targetId)); requireHospitalResourceAccess(actor, "hospital_resource.view", resource.departmentCode); return reference(`${resource.code} · ${resource.name}`, `/admin/resources?resourceId=${resource.id}`); }
    case "HOSPITAL_SERVICE": { const service = findOrThrowScoped(state.hospitalServices.find((entry) => entry.id === targetId)); requirePermission(actor, "service.catalog.view", { departmentCode: service.departmentCode }); return reference(`${service.code} · ${service.name}`, `/admin/hospital-services?serviceId=${service.id}`); }
    case "DIAGNOSTIC_ITEM": { const item = findOrThrowScoped(state.items.find((entry) => entry.id === targetId)); requireItemPermission(state, actor, "item.view", item); const request = findOrThrowScoped(state.requests.find((entry) => entry.id === item.requestId)); const service = state.services.find((entry) => entry.id === item.serviceId); return reference(`${request.requestCode} · ${service?.name ?? "Exame"}`, `/requests/${request.id}#${item.id}`); }
    case "DIAGNOSTIC_REQUEST": { const request = findOrThrowScoped(state.requests.find((entry) => entry.id === targetId)); requireRequestPermission(state, actor, "request.view", request); return reference(request.requestCode, `/requests/${request.id}`); }
    case "SAVED_PLANNER_VIEW": { const view = findOrThrowScoped(state.savedPlannerViews.find((entry) => entry.id === targetId && entry.active)); requirePermission(actor, "planner_view.view", {}); if (view.ownerId !== actor.id) { if (!view.sharedDepartmentCode) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a esta visão.", 404); requireHospitalTaskAccess(state, actor, "planner_view.view", { departmentCode: view.sharedDepartmentCode }); } return reference(view.name, `/planner?viewId=${view.id}`); }
    case "DEPARTMENT": { const department = findOrThrowScoped(state.departments.find((entry) => entry.id === targetId)); if (!canAccessResource(actor, "department.view", { departmentCode: department.code })) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este setor.", 404); return reference(`${department.code} · ${department.name}`, `/admin/departments?departmentId=${department.id}`); }
    default: throw new ApiError("VALIDATION_ERROR", "Tipo de referência inválido.", 400);
  }
}
export function canResolveWorkActivity(state: StoreState, actor: User, targetType: WorkActivityTargetType, targetId: string): boolean { try { resolveWorkActivity(state, actor, targetType, targetId); return true; } catch { return false; } }
