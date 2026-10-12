import type { HospitalMetricCode, HospitalMetricDefinition, Permission } from "@cvg/contracts";

const definition = (code: HospitalMetricCode, label: string, source: string, description: string, timeBasis: HospitalMetricDefinition["timeBasis"] = "EVENT_IN_WINDOW"): HospitalMetricDefinition => ({ code, label, source, description, timeBasis, version: "HPL-OPERATIONAL-1", unit: "COUNT", denominator: code === "ACTIVITY_HANDED_OVER" ? "AUTHORIZED_UNIQUE_ACTIVITIES" : "AUTHORIZED_UNIQUE_OBJECTS", approval: "TECHNICAL_DEFINITION_REQUIRES_PILOT_ACCEPTANCE" });
export const HOSPITAL_METRIC_DEFINITIONS: readonly HospitalMetricDefinition[] = [
  definition("TASK_CREATED", "Tarefas criadas", "HospitalTask.createdAt", "Tarefas distintas criadas no intervalo e atualmente autorizadas."),
  definition("TASK_COMPLETED", "Tarefas concluídas", "HospitalTask.completedAt", "Conclusões registradas no intervalo; não representa conclusão de exames."),
  definition("TASK_PENDING", "Tarefas da coorte ainda pendentes", "HospitalTask.createdAt + current phase", "Tarefas criadas no intervalo cuja fase atual é PENDING ou IN_PROGRESS. Não reconstrói o saldo histórico no fim da janela.", "COHORT_IN_WINDOW_CURRENT_STATE"),
  definition("TASK_CANCELLED", "Tarefas canceladas", "HospitalTask.cancelledAt", "Cancelamentos registrados no intervalo."),
  definition("DIAGNOSTIC_REQUESTED", "Exames solicitados", "DiagnosticItem.requestedAt", "Exames distintos solicitados no intervalo, contados uma vez independentemente de vínculos em planos."),
  definition("DIAGNOSTIC_EXECUTED", "Exames executados", "DiagnosticItem.performedAt or laboratory completedAt", "Execução registrada no intervalo; realização de imagem e conclusão laboratorial são distintas de liberação ou revisão."),
  definition("DIAGNOSTIC_REVIEWED", "Exames revisados", "DiagnosticItem.reviewedAt", "Revisão registrada no intervalo, distinta de execução ou leitura de aviso."),
  definition("DIAGNOSTIC_PENDING", "Exames da coorte ainda pendentes", "DiagnosticItem.requestedAt + current status", "Exames solicitados no intervalo fora de estados terminais no momento da consulta.", "COHORT_IN_WINDOW_CURRENT_STATE"),
  definition("DIAGNOSTIC_OVERDUE", "Exames da coorte pendentes e atrasados", "DiagnosticItem.requestedAt + captured dueAt + current status", "Pendências da coorte com prazo capturado anterior ao momento da consulta; agenda não pausa o relógio.", "COHORT_IN_WINDOW_CURRENT_STATE"),
  definition("PLAN_CREATED", "Planos criados", "HospitalPlan.createdAt", "Planos distintos criados no intervalo, sem somar novamente seus exames."),
  definition("PLAN_CLOSED", "Planos encerrados", "HospitalPlan.closedAt", "Encerramentos explícitos de plano no intervalo; atividades vinculadas conservam seu estado."),
  definition("SHIFT_STARTED", "Plantões com início na janela", "HospitalShift.startAt", "Plantões cadastrados cujo início planejado está no intervalo; não atesta presença profissional."),
  definition("ACTIVITY_HANDED_OVER", "Atividades com passagem aceita", "HospitalHandoff.acceptedAt + current authorized target", "Atividades distintas com ao menos uma passagem aceita no intervalo; considera somente alvos atualmente autorizados e não confirma alerta crítico.")
];
export function hospitalMetricDefinition(code: HospitalMetricCode) { return HOSPITAL_METRIC_DEFINITIONS.find((entry) => entry.code === code)!; }
export function hospitalMetricSourcePermission(code: HospitalMetricCode): Permission {
  return code.startsWith("TASK_") ? "hospital_task.view" : code.startsWith("DIAGNOSTIC_") ? "item.view" : code.startsWith("PLAN_") ? "plan.view" : "shift.view";
}
