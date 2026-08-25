import type {
  ItemState,
  OperationalAction,
  OperationalBlocker,
  OperationalContext,
  OperationalEscalationLevel,
  OperationalOwner,
  Priority,
  WorkflowType
} from "@cvg/contracts";

export interface OperationalContextInput {
  status: ItemState;
  workflowType: WorkflowType;
  priority: Priority;
  departmentCode: string;
  requestingDepartmentCode?: string;
  requiresSample: boolean;
  requiresSchedule: boolean;
  requestedAt: string;
  receivedAt?: string;
  startedAt?: string;
  performedAt?: string;
  releasedAt?: string;
  dueAt?: string;
  asOf: string;
}

const terminalStates = new Set<ItemState>(["COMPLETED", "CANCELLED", "REJECTED"]);

const ownerLabels: Record<OperationalOwner["code"], string> = {
  REQUESTING_TEAM: "Equipe solicitante",
  LABORATORY: "Laboratório",
  RADIOLOGY: "Radiologia",
  ULTRASOUND: "Ultrassom",
  DIAGNOSTICS_OPERATIONS: "Operação diagnóstica",
  UNKNOWN: "A definir"
};

const actionLabels: Record<OperationalAction["code"], string> = {
  COLLECT_SAMPLE: "Receber amostra",
  SCHEDULE_EXAM: "Agendar exame",
  ROUTE_PATIENT: "Encaminhar paciente",
  START_PROCESSING: "Iniciar processamento",
  REGISTER_RESULT: "Registrar resultado",
  MARK_PERFORMED: "Marcar exame realizado",
  PRODUCE_REPORT: "Produzir laudo",
  REVIEW_RESULT: "Revisar resultado",
  REGISTER_REPLACEMENT_RESULT: "Registrar resultado substituto",
  COLLECT_REPLACEMENT_SAMPLE: "Aguardar nova coleta",
  MONITOR_ITEM: "Acompanhar item"
};

const blockerLabels: Record<OperationalBlocker["code"], string> = {
  WAITING_SAMPLE: "Aguardando amostra",
  WAITING_REPLACEMENT_SAMPLE: "Aguardando nova amostra",
  WAITING_SCHEDULE: "Aguardando agendamento",
  WAITING_REPORT: "Aguardando laudo"
};

function ownerForDepartment(departmentCode: string): OperationalOwner {
  const normalized = departmentCode.trim().toUpperCase();
  const code = normalized === "LABORATORY" ? "LABORATORY"
    : normalized === "RADIOLOGY" ? "RADIOLOGY"
      : normalized === "ULTRASOUND" ? "ULTRASOUND"
        : normalized ? "DIAGNOSTICS_OPERATIONS" : "UNKNOWN";
  return { code, label: ownerLabels[code] };
}

function requestingOwner(input: OperationalContextInput): OperationalOwner {
  const code = input.requestingDepartmentCode?.trim().toUpperCase();
  return code ? { code: "REQUESTING_TEAM", label: `Equipe solicitante · ${code}` } : { code: "REQUESTING_TEAM", label: ownerLabels.REQUESTING_TEAM };
}

function actionFor(input: OperationalContextInput): OperationalAction {
  const code = input.status === "REQUESTED" && input.requiresSample ? "COLLECT_SAMPLE"
    : input.status === "REQUESTED" && input.requiresSchedule ? "SCHEDULE_EXAM"
      : input.status === "REQUESTED" ? "ROUTE_PATIENT"
        : input.status === "RECEIVED" ? "START_PROCESSING"
          : input.status === "IN_PROGRESS" && input.workflowType === "LABORATORY" ? "REGISTER_RESULT"
            : input.status === "IN_PROGRESS" ? "MARK_PERFORMED"
              : input.status === "AWAITING_REPORT" ? "PRODUCE_REPORT"
                : input.status === "RESULT_AVAILABLE" ? "REVIEW_RESULT"
                  : input.status === "RESULT_VOIDED" ? "REGISTER_REPLACEMENT_RESULT"
                    : input.status === "RECOLLECTION_REQUIRED" ? "COLLECT_REPLACEMENT_SAMPLE"
                      : "MONITOR_ITEM";
  return { code, label: actionLabels[code] };
}

function blockerFor(input: OperationalContextInput): OperationalBlocker | null {
  if (input.status === "REQUESTED" && input.requiresSample) return { code: "WAITING_SAMPLE", label: blockerLabels.WAITING_SAMPLE };
  if (input.status === "REQUESTED" && input.requiresSchedule) return { code: "WAITING_SCHEDULE", label: blockerLabels.WAITING_SCHEDULE };
  if (input.status === "AWAITING_REPORT") return { code: "WAITING_REPORT", label: blockerLabels.WAITING_REPORT };
  if (input.status === "RECOLLECTION_REQUIRED") return { code: "WAITING_REPLACEMENT_SAMPLE", label: blockerLabels.WAITING_REPLACEMENT_SAMPLE };
  return null;
}

function validTimestamp(value: string | undefined): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function waitingSinceFor(input: OperationalContextInput, blocker: OperationalBlocker | null): string | null {
  if (!blocker) return null;
  if (blocker.code === "WAITING_REPORT") return validTimestamp(input.performedAt) ?? validTimestamp(input.startedAt) ?? validTimestamp(input.requestedAt);
  return validTimestamp(input.requestedAt);
}

function escalationFor(input: OperationalContextInput): OperationalEscalationLevel {
  if (terminalStates.has(input.status)) return "NONE";
  const dueAt = validTimestamp(input.dueAt);
  const asOf = validTimestamp(input.asOf);
  if (!dueAt || !asOf) return "WATCH";
  const overdue = Date.parse(dueAt) < Date.parse(asOf);
  if (overdue && input.priority === "EMERGENCY") return "URGENT";
  if (overdue) return "ATTENTION";
  if (input.priority === "EMERGENCY") return "ATTENTION";
  if (input.priority === "URGENT") return "WATCH";
  return "NONE";
}

function currentOwnerFor(input: OperationalContextInput, action: OperationalAction): OperationalOwner {
  if (input.status === "RESULT_AVAILABLE" || input.status === "RECOLLECTION_REQUIRED") return requestingOwner(input);
  if (input.status === "REQUESTED" && input.requiresSample) return requestingOwner(input);
  if (action.code === "MONITOR_ITEM" && terminalStates.has(input.status)) return requestingOwner(input);
  return ownerForDepartment(input.departmentCode);
}

export function deriveOperationalContext(input: OperationalContextInput): OperationalContext {
  const nextAction = actionFor(input);
  const blockedBy = blockerFor(input);
  return {
    currentOwner: currentOwnerFor(input, nextAction),
    nextAction,
    blockedBy,
    waitingSince: waitingSinceFor(input, blockedBy),
    expectedBy: validTimestamp(input.dueAt),
    escalationLevel: escalationFor(input)
  };
}

export * from "./laboratory-result";
