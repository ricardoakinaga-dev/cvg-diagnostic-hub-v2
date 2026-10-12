import { canAccessHospitalPlan } from "./hospital-plan-policy";
import { canAccessChecklistTemplate } from "./hospital-checklist-policy";
import { canAccessHospitalDocument } from "./hospital-document-policy";
import { canAccessHospitalResource } from "./hospital-resource-policy";
import { requirePlannerFilterReferences, matchesPlanActivity } from "./hospital-planner-filter";
import type { PlannerSearchPage, PlannerSearchResult } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { PlannerSearchFilters } from "./hospital-task-types";
import { canAccessResource } from "../security/authorization";
import { plannerSearchFiltersSchema } from "../http/hospital-task-schemas";
import { canViewItem, requireActiveUser, requirePatientPermission, requirePermission, requireRequestPermission, requestViewForActor } from "./service-common";
import { canAccessHospitalTask, taskDate, validateTaskDates } from "./hospital-task-policy";
import { matchesTaskFilters, validateTaskBody } from "./hospital-task-common";
import { pagePlannerActivities } from "./hospital-task-pagination";
import { diagnosticPlannerPhase, matchesDiagnosticPlannerFilters } from "@cvg/domain";

export function createPlannerSearchService({ store }: ApplicationServiceContext) {
  return {
    async searchPlanner(actor: User, query: string, filters: PlannerSearchFilters = {}): Promise<PlannerSearchPage> {
      validateTaskBody(plannerSearchFiltersSchema, { ...filters, query });
      validateTaskDates(taskDate(filters.from), taskDate(filters.to));
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "search.execute", {});
      requirePlannerFilterReferences(state, current, filters);
      const text = query.trim().toLocaleLowerCase("pt-BR"); const rows: PlannerSearchResult[] = [];
      const includes = (value: string) => !text || value.toLocaleLowerCase("pt-BR").includes(text);
      const accepts = (type: PlannerSearchResult["type"]) => !filters.types || filters.types.includes(type);
      const from = taskDate(filters.from); const to = taskDate(filters.to);
      const inPeriod = (at: string) => (!from || at >= from) && (!to || at <= to);
      const patientVisible = (patientId: string) => { try { requirePatientPermission(state, current, "patient.view", patientId); return true; } catch { return false; } };
      if (accepts("HOSPITAL_TASK")) {
        for (const task of state.hospitalTasks) {
          if (!canAccessHospitalTask(state, current, "hospital_task.view", task) || !matchesTaskFilters(task, current, filters) || !matchesPlanActivity(state, filters, "HOSPITAL_TASK", task.id)) continue;
          const patient = state.patients.find((entry) => entry.id === task.patientId);
          if (includes(`${task.taskCode} ${task.title} ${task.description ?? ""} ${patient?.displayName ?? ""} ${patient?.externalId ?? ""}`)) rows.push({ type: "HOSPITAL_TASK", id: task.id, label: `${task.taskCode} · ${task.title}`, patient: patient?.displayName, patientId: task.patientId, departmentCode: task.departmentCode, status: task.status, priority: task.priority, responsibleUserId: task.responsibleUserId, plannedStartAt: task.plannedStartAt, updatedAt: task.updatedAt, deepLink: `/planner/tasks/${task.id}` });
        }
      }
      const taskOnlyFilter = Boolean(filters.typeId);
      const itemPhase = diagnosticPlannerPhase;
      if (!taskOnlyFilter && accepts("DIAGNOSTIC_ITEM")) {
        for (const item of state.items) {
          if (!canViewItem(state, current, item) || !matchesPlanActivity(state, filters, "DIAGNOSTIC_ITEM", item.id) || filters.shiftId && item.shiftId !== filters.shiftId) continue;
          const request = state.requests.find((entry) => entry.id === item.requestId);
          if (!request || !patientVisible(request.patientId) || filters.encounterId && request.encounterId !== filters.encounterId) continue;
          if (!matchesDiagnosticPlannerFilters({ ...item, createdAt: item.requestedAt }, filters, true) || filters.patientId && request.patientId !== filters.patientId || filters.status && item.status !== filters.status || filters.assignedToMe && item.assignedUserId !== current.id) continue;
          const patient = state.patients.find((entry) => entry.id === request.patientId); const service = state.services.find((entry) => entry.id === item.serviceId);
          if (includes(`${item.id} ${request.requestCode} ${service?.name ?? ""} ${service?.code ?? ""} ${patient?.displayName ?? ""} ${patient?.externalId ?? ""}`)) rows.push({ type: "DIAGNOSTIC_ITEM", id: item.id, label: `${request.requestCode} · ${service?.name ?? "Exame"}`, patient: patient?.displayName, patientId: request.patientId, departmentCode: item.departmentCode, status: item.status, priority: item.priority, responsibleUserId: item.assignedUserId, plannedStartAt: item.plannedStartsAt, updatedAt: item.requestedAt, deepLink: `/requests/${request.id}#${item.id}` });
        }
      }
      if (!taskOnlyFilter && accepts("DIAGNOSTIC_REQUEST")) {
        for (const request of state.requests) {
          try {
            requireRequestPermission(state, current, "request.view", request);
            if (filters.encounterId && request.encounterId !== filters.encounterId || !patientVisible(request.patientId) || !inPeriod(request.createdAt) || filters.patientId && filters.patientId !== request.patientId) continue;
            const view = requestViewForActor(state, current, request);
            const items = view.items.filter((item) => matchesPlanActivity(state, filters, "DIAGNOSTIC_ITEM", item.id) && (!filters.shiftId || item.shiftId === filters.shiftId) && (!filters.departmentCode || item.departmentCode === filters.departmentCode) && (!filters.priority || item.priority === filters.priority) && (!filters.status || item.status === filters.status) && (!filters.phase || itemPhase(item.status) === filters.phase) && (!filters.responsibleUserId || item.assignedUserId === filters.responsibleUserId) && (!filters.assignedToMe || item.assignedUserId === current.id));
            if (!items.length) continue;
            const patient = state.patients.find((entry) => entry.id === request.patientId);
            if (includes(`${request.requestCode} ${patient?.displayName ?? ""} ${patient?.externalId ?? ""}`)) rows.push({ type: "DIAGNOSTIC_REQUEST", id: request.id, label: request.requestCode, patient: patient?.displayName, patientId: request.patientId, status: view.aggregateStatus, priority: request.priority, updatedAt: view.updatedAt, deepLink: `/requests/${request.id}` });
          } catch { continue; }
        }
      }
      const activityFilters = Boolean(filters.planId || filters.shiftId || filters.typeId || filters.phase || filters.status || filters.priority || filters.responsibleUserId || filters.assignedToMe);
      if (!activityFilters) {
        for (const patient of state.patients) {
          if (!patientVisible(patient.id) || filters.patientId && filters.patientId !== patient.id) continue;
          const encounters = state.encounters.filter((entry) => entry.patientId === patient.id);
          const scopedEncounter = (encounterId: string) => (!filters.encounterId || filters.encounterId === encounterId) && (!filters.departmentCode || state.admissions.some((entry) => entry.encounterId === encounterId && entry.departmentCode === filters.departmentCode) || state.requests.some((entry) => entry.encounterId === encounterId && entry.requestingDepartmentCode === filters.departmentCode));
          const last = encounters.filter((encounter) => scopedEncounter(encounter.id) && inPeriod(encounter.openedAt)).sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
          if (accepts("PATIENT") && last && includes(`${patient.id} ${patient.displayName} ${patient.externalId}`)) rows.push({ type: "PATIENT", id: patient.id, label: `${patient.displayName} · ${patient.externalId}`, patient: patient.displayName, patientId: patient.id, updatedAt: last.openedAt, deepLink: `/patients/${patient.id}/diagnostics` });
          if (!accepts("ENCOUNTER") || !canAccessResource(current, "encounter.view", { ...(current.role === "MANAGER" ? { departmentCode: current.departmentCode } : { patientId: patient.id }) })) continue;
          for (const encounter of encounters) if (scopedEncounter(encounter.id) && inPeriod(encounter.openedAt) && includes(`${encounter.id} ${encounter.externalId} ${patient.displayName} ${patient.externalId}`)) rows.push({ type: "ENCOUNTER", id: encounter.id, label: encounter.externalId, patient: patient.displayName, patientId: patient.id, status: encounter.status, updatedAt: encounter.openedAt, deepLink: `/patients/${patient.id}/diagnostics` });
        }
      }
      if (!filters.typeId && !filters.phase && !filters.status && !filters.priority && !filters.assignedToMe && !filters.responsibleUserId) {
        if (accepts("HOSPITAL_PLAN") && !filters.shiftId) for (const plan of state.hospitalPlans) if (canAccessHospitalPlan(state, current, "plan.view", plan) && (!filters.planId || plan.id === filters.planId) && (!filters.patientId || plan.patientId === filters.patientId) && (!filters.encounterId || plan.encounterId === filters.encounterId) && (!filters.departmentCode || plan.departmentCodes.includes(filters.departmentCode)) && inPeriod(plan.plannedStartAt ?? plan.createdAt) && includes(`${plan.code} ${plan.title} ${plan.objective}`)) rows.push({ type: "HOSPITAL_PLAN", id: plan.id, label: `${plan.code} · ${plan.title}`, patientId: plan.patientId, status: plan.state, plannedStartAt: plan.plannedStartAt, updatedAt: plan.updatedAt, deepLink: `/planner/plans/${plan.id}` });
        if (accepts("HOSPITAL_SHIFT") && !filters.planId && !filters.patientId && !filters.encounterId) for (const shift of state.hospitalShifts) if (canAccessHospitalTask(state, current, "shift.view", shift) && (!filters.shiftId || shift.id === filters.shiftId) && (!filters.departmentCode || shift.departmentCode === filters.departmentCode) && inPeriod(shift.startAt) && includes(`${shift.code} ${shift.name}`)) rows.push({ type: "HOSPITAL_SHIFT", id: shift.id, label: `${shift.code} · ${shift.name}`, departmentCode: shift.departmentCode, status: shift.status, plannedStartAt: shift.startAt, updatedAt: shift.updatedAt, deepLink: `/planner/shifts/${shift.id}` });
        if (accepts("CHECKLIST_TEMPLATE") && !filters.planId && !filters.shiftId && !filters.patientId && !filters.encounterId) for (const template of state.hospitalChecklistTemplates) if (canAccessChecklistTemplate(state, current, "checklist_template.view", template) && (!filters.departmentCode || template.departmentCode === filters.departmentCode) && inPeriod(template.createdAt) && includes(`${template.code} ${template.name}`)) rows.push({ type: "CHECKLIST_TEMPLATE", id: template.id, label: `${template.code} · ${template.name}`, departmentCode: template.departmentCode, status: template.status, updatedAt: template.updatedAt, deepLink: `/planner/checklists?templateId=${template.id}` });
        if (accepts("HOSPITAL_RECURRENCE") && !filters.planId && !filters.shiftId) for (const recurrence of state.hospitalRecurrences) if (canAccessHospitalTask(state, current, "recurrence.view", recurrence) && (!filters.patientId || recurrence.patientId === filters.patientId) && (!filters.encounterId || recurrence.encounterId === filters.encounterId) && (!filters.departmentCode || recurrence.departmentCode === filters.departmentCode) && inPeriod(recurrence.startAt) && includes(recurrence.title)) rows.push({ type: "HOSPITAL_RECURRENCE", id: recurrence.id, label: recurrence.title, patientId: recurrence.patientId, departmentCode: recurrence.departmentCode, status: recurrence.active ? "ACTIVE" : "INACTIVE", plannedStartAt: recurrence.startAt, updatedAt: recurrence.updatedAt, deepLink: `/planner/recurrences?recurrenceId=${recurrence.id}` });
      }
      // Metadata has its own authority and responsibility, without patient,
      // task phase or clinical priority. Do not broaden incompatible filters.
      if (!filters.planId && !filters.shiftId && !filters.patientId && !filters.encounterId && !filters.typeId && !filters.phase && !filters.priority && !filters.label) {
        const responsibilityMatches = (responsibleUserId?: string) => (!filters.responsibleUserId || responsibleUserId === filters.responsibleUserId) && (!filters.assignedToMe || responsibleUserId === current.id);
        if (accepts("HOSPITAL_DOCUMENT")) for (const document of state.hospitalDocuments) {
          if (!canAccessHospitalDocument(current, "hospital_document.view", document.departmentCode) || filters.departmentCode && document.departmentCode !== filters.departmentCode || document.archived && !filters.includeArchived || !responsibilityMatches(document.responsibleUserId) || !inPeriod(document.updatedAt)) continue;
          const revision = document.revisions.find(entry => entry.id === document.currentPublishedRevisionId) ?? document.revisions.find(entry => entry.id === document.draftRevisionId);
          const status = document.archived ? "ARCHIVED" : revision?.status;
          if (filters.status && filters.status !== status || !includes(`${document.id} ${document.code} ${document.title}`)) continue;
          rows.push({ type: "HOSPITAL_DOCUMENT", id: document.id, label: `${document.code} · ${document.title}`, departmentCode: document.departmentCode, responsibleUserId: document.responsibleUserId, status, updatedAt: document.updatedAt, deepLink: `/planner/documents/${document.id}` });
        }
        if (accepts("HOSPITAL_RESOURCE")) for (const resource of state.hospitalResources) {
          if (!canAccessHospitalResource(current, "hospital_resource.view", resource.departmentCode) || filters.departmentCode && resource.departmentCode !== filters.departmentCode || !responsibilityMatches(resource.userId) || !inPeriod(resource.updatedAt)) continue;
          const status = resource.active ? resource.availability : "INACTIVE";
          if (filters.status && filters.status !== status || !includes(`${resource.id} ${resource.code} ${resource.name} ${resource.ward ?? ""} ${resource.bedLabel ?? ""}`)) continue;
          rows.push({ type: "HOSPITAL_RESOURCE", id: resource.id, label: `${resource.code} · ${resource.name}`, departmentCode: resource.departmentCode, ...(resource.userId ? { responsibleUserId: resource.userId } : {}), status, updatedAt: resource.updatedAt, deepLink: `/admin/resources?resourceId=${resource.id}` });
        }
      }
      // Only authorized objects are counted, ranked or serialized into a cursor.
      return pagePlannerActivities(rows, filters, (row) => ({ ...row, id: `${row.type}:${row.id}` }));
    }
  };
}
