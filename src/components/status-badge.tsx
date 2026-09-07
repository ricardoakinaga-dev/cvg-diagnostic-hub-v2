import type { ItemState, Priority } from "@cvg/contracts";
import { Icon } from "./ui-icons";

const statusLabels: Record<ItemState, string> = {
  REQUESTED: "Solicitado",
  RECEIVED: "Amostra recebida",
  SCHEDULED: "Agendado",
  IN_PROGRESS: "Em execução",
  AWAITING_REPORT: "Aguardando laudo",
  RESULT_AVAILABLE: "Resultado disponível",
  REVIEWED: "Revisado",
  COMPLETED: "Concluído",
  RECOLLECTION_REQUIRED: "Recoleta necessária",
  FAILED: "Pendente",
  CANCELLED: "Cancelado",
  REJECTED: "Rejeitado",
  RESULT_VOIDED: "Resultado invalidado"
};

const statusTone: Record<ItemState, string> = {
  REQUESTED: "neutral",
  RECEIVED: "info",
  SCHEDULED: "info",
  IN_PROGRESS: "accent",
  AWAITING_REPORT: "accent",
  RESULT_AVAILABLE: "success",
  REVIEWED: "success",
  COMPLETED: "success",
  RECOLLECTION_REQUIRED: "warning",
  FAILED: "danger",
  CANCELLED: "muted",
  REJECTED: "danger",
  RESULT_VOIDED: "danger"
};

const priorityLabels: Record<Priority, string> = { ROUTINE: "Rotina", URGENT: "Urgente", EMERGENCY: "Emergência" };
type StatusTone = "neutral" | "info" | "accent" | "success" | "warning" | "danger" | "muted";

export function StatusBadge({ status, label, tone }: { status: ItemState; label?: string; tone?: StatusTone }) {
  return <span className={`status-badge status-${tone ?? statusTone[status]}`}><span aria-hidden="true" className="status-dot" />{label ?? statusLabels[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const icon = priority === "EMERGENCY" ? "attention" : priority === "URGENT" ? "arrow-up" : "dot";
  return <span className={`priority-badge priority-${priority.toLowerCase()}`}><span aria-hidden="true" className="priority-icon"><Icon name={icon} size={12} /></span>{priorityLabels[priority]}</span>;
}

export function statusLabel(status: ItemState): string {
  return statusLabels[status];
}

export function priorityLabel(priority: Priority): string {
  return priorityLabels[priority];
}
