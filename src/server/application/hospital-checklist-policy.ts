import type { HospitalChecklistSnapshot, HospitalChecklistTemplate, HospitalTask, Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { rolePermissions } from "../security/authorization";
import { findOrThrowScoped, requirePermission } from "./service-common";
import { requireHospitalTaskAccess, validateNewTaskContext } from "./hospital-task-policy";

export function requireChecklistTemplateAccess(state: StoreState, actor: User, permission: Permission, template: Pick<HospitalChecklistTemplate, "departmentCode">): void {
  if (actor.role === "ADMIN") requirePermission(actor, permission, { departmentCode: template.departmentCode });
  else requireHospitalTaskAccess(state, actor, permission, template);
}
export function canAccessChecklistTemplate(state: StoreState, actor: User, permission: Permission, template: Pick<HospitalChecklistTemplate, "departmentCode">): boolean {
  try { requireChecklistTemplateAccess(state, actor, permission, template); return true; } catch { return false; }
}
export function validateChecklistTemplate(template: Pick<HospitalChecklistTemplate, "steps" | "clinicalProcess" | "careContextRequired">): void {
  if (!template.steps.length || new Set(template.steps.map((step) => step.code)).size !== template.steps.length) throw new ApiError("VALIDATION_ERROR", "Defina etapas distintas para o modelo.", 400);
  const process = template.clinicalProcess;
  if (process && (!template.careContextRequired || !process.allowedExecutorRoles.length || new Set(process.allowedExecutorRoles).size !== process.allowedExecutorRoles.length || process.allowedExecutorRoles.some((role) => !rolePermissions[role].includes("care.execute")) || !process.clinicalSystemReference.trim() || !process.confirmationPolicyReference.trim())) throw new ApiError("VALIDATION_ERROR", "O processo clínico exige contexto, executores elegíveis e referências de registro e confirmação.", 400);
}
export function captureApprovedChecklist(state: StoreState, templateId: string, context: Pick<HospitalTask, "departmentCode" | "patientId" | "encounterId">, at: string): HospitalChecklistSnapshot {
  const template = findOrThrowScoped(state.hospitalChecklistTemplates.find((entry) => entry.id === templateId));
  if (template.status !== "APPROVED" || !template.approvedBy || !template.approvedAt) throw new ApiError("CHECKLIST_NOT_APPROVED", "Selecione um modelo aprovado para novas ocorrências.", 409);
  if (template.departmentCode !== context.departmentCode) throw new ApiError("VALIDATION_ERROR", "O modelo pertence a outro setor.", 400);
  validateNewTaskContext(state, context, template.careContextRequired || Boolean(template.clinicalProcess));
  validateChecklistTemplate(template);
  return structuredClone({ templateId: template.id, templateVersion: template.version, code: template.code, name: template.name, departmentCode: template.departmentCode, careContextRequired: template.careContextRequired, steps: template.steps, clinicalProcess: template.clinicalProcess, approvedBy: template.approvedBy, approvedAt: template.approvedAt, capturedAt: at });
}
export function checklistComplete(task: Pick<HospitalTask, "checklistSnapshot" | "checklistExecutions">): boolean {
  return !task.checklistSnapshot || task.checklistSnapshot.steps.filter((step) => step.required).every((step) => task.checklistExecutions?.some((execution) => execution.stepCode === step.code && execution.status === "DONE" && (!step.evidenceRequired || Boolean(execution.evidenceText?.trim()))));
}
export function requireChecklistComplete(task: Pick<HospitalTask, "checklistSnapshot" | "checklistExecutions">): void {
  if (!checklistComplete(task)) throw new ApiError("CHECKLIST_PENDING", "Conclua as etapas obrigatórias do checklist antes de finalizar.", 409);
}
export function checklistTemplateView(state: StoreState, actor: User, template: HospitalChecklistTemplate, permission: Permission = "checklist_template.view") {
  requireChecklistTemplateAccess(state, actor, permission, template);
  const permissions = (["checklist_template.view", "checklist_template.manage", "checklist_template.approve"] as const).filter((permission) => canAccessChecklistTemplate(state, actor, permission, template) && (permission !== "checklist_template.approve" || template.status === "DRAFT"));
  return { template: structuredClone(template), permissions };
}
