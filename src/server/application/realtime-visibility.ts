import type { StoreState, User } from "../domain/models";
import { canViewItem, canViewRequest, requireActiveUser } from "./service-common";
import { findById } from "../domain/state-index";
import { canAccessResource } from "../security/authorization";
import { canAccessHospitalTask, taskTypeReadable } from "./hospital-task-policy";
import { canAccessHospitalPlan } from "./hospital-plan-policy";
import { canAccessChecklistTemplate } from "./hospital-checklist-policy";
import { canAccessHospitalDocument } from "./hospital-document-policy";
import { canResolveWorkActivity } from "./work-activity-policy";
import { canAccessHospitalReport } from "./hospital-report-policy";

/** Events expose only aggregate metadata; resolve their scope from current state. */
export function eventVisible(state: StoreState, actor: User, entityType: string, entityId: string, _payload: Record<string, unknown>): boolean {
  try { actor = requireActiveUser(state, actor); } catch { return false; }
  const itemVisible = (itemId: string | undefined) => {
    const item = findById(state.items, itemId);
    return Boolean(item && canViewItem(state, actor, item));
  };
  const resultVisible = (resultId: string | undefined) => itemVisible(findById(state.results, resultId)?.itemId);
  switch (entityType) {
    case "HospitalReport": return canAccessHospitalReport(state, actor, entityId);
    case "HospitalDocument": {
      const document = state.hospitalDocuments.find((entry) => entry.id === entityId);
      return Boolean(document && canAccessHospitalDocument(actor, "hospital_document.view", document.departmentCode));
    }
    case "HospitalTaskComment": {
      const comment = state.hospitalTaskComments.find((entry) => entry.id === entityId); const task = state.hospitalTasks.find((entry) => entry.id === comment?.taskId);
      return Boolean(task && canAccessHospitalTask(state, actor, "hospital_task.view", task) && canAccessHospitalTask(state, actor, "hospital_task.comment.view", task));
    }
    case "HospitalTaskAttachment": {
      const attachment = state.hospitalTaskAttachments.find((entry) => entry.id === entityId); const task = state.hospitalTasks.find((entry) => entry.id === attachment?.taskId);
      return Boolean(task && canAccessHospitalTask(state, actor, "hospital_task.view", task) && canAccessHospitalTask(state, actor, "hospital_task.attachment.view", task));
    }
    case "WorkNotification": {
      const notification = state.workNotifications.find((entry) => entry.id === entityId);
      return Boolean(notification && notification.userId === actor.id && canAccessResource(actor, "work_notification.view", {}) && canResolveWorkActivity(state, actor, notification.targetType, notification.targetId));
    }
    case "UserWorkInbox": return entityId === actor.id && canAccessResource(actor, "work_notification.view", {});
    case "WorkActivityPreference": { const preference = state.workActivityPreferences.find((entry) => entry.id === entityId); return Boolean(preference && preference.userId === actor.id && canAccessResource(actor, "work_activity.preference.manage", {}) && canResolveWorkActivity(state, actor, preference.targetType, preference.targetId)); }
    case "WorkNotificationPreference": return state.workNotificationPreferences.some((entry) => entry.id === entityId && entry.userId === actor.id) && canAccessResource(actor, "work_notification.preferences.manage", {});
    case "HospitalPlan": {
      const plan = state.hospitalPlans.find((entry) => entry.id === entityId);
      return Boolean(plan && canAccessHospitalPlan(state, actor, "plan.view", plan));
    }
    case "HospitalShift": {
      const shift = state.hospitalShifts.find((entry) => entry.id === entityId);
      return Boolean(shift && canAccessHospitalTask(state, actor, "shift.view", shift));
    }
    case "HospitalHandoff": {
      const handoff = state.hospitalHandoffs.find((entry) => entry.id === entityId);
      return Boolean(handoff && canAccessHospitalTask(state, actor, "shift.view", handoff));
    }
    case "HospitalChecklistTemplate": {
      const template = state.hospitalChecklistTemplates.find((entry) => entry.id === entityId);
      return Boolean(template && canAccessChecklistTemplate(state, actor, "checklist_template.view", template));
    }
    case "HospitalRecurrence": {
      const recurrence = state.hospitalRecurrences.find((entry) => entry.id === entityId);
      return Boolean(recurrence && canAccessHospitalTask(state, actor, "recurrence.view", recurrence));
    }
    case "HospitalTask": {
      const task = state.hospitalTasks.find((entry) => entry.id === entityId);
      return Boolean(task && canAccessHospitalTask(state, actor, "hospital_task.view", task));
    }
    case "HospitalIntake": {
      const intake = state.hospitalIntakes.find((entry) => entry.id === entityId);
      return Boolean(intake && canAccessHospitalTask(state, actor, "hospital_intake.view", intake));
    }
    case "HospitalTaskType":
      return state.hospitalTaskTypes.some((entry) => entry.id === entityId) && taskTypeReadable(actor);
    case "HospitalService": {
      const service = state.hospitalServices.find((entry) => entry.id === entityId);
      return Boolean(service && canAccessResource(actor, "service.catalog.view", { departmentCode: service.departmentCode }));
    }
    case "HospitalServiceCatalog":
      return (actor.role === "ADMIN" || actor.role === "SUPERADMIN") && canAccessResource(actor, "service.catalog.view", {});
    case "DiagnosticRequest": {
      const request = findById(state.requests, entityId);
      return Boolean(request && canViewRequest(state, actor, request));
    }
    case "DiagnosticRequestItem":
      return itemVisible(entityId);
    case "Sample":
      return findById(state.samples, entityId)?.itemIds.some(itemVisible) ?? false;
    case "Result":
      return resultVisible(entityId);
    case "Procedure":
      return itemVisible(findById(state.procedures, entityId)?.itemId);
    case "Attachment": {
      const versionId = findById(state.attachments, entityId)?.resultVersionId;
      return resultVisible(findById(state.resultVersions, versionId)?.resultId);
    }
    case "ResultVersion":
      return resultVisible(findById(state.resultVersions, entityId)?.resultId);
    default:
      return false;
  }
}
