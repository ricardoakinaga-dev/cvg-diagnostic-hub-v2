import { TERMINAL_ITEM_STATES, type ItemState, type OperationalContext, type Patient, type Priority, type QueueItem, type WorkflowType } from "@cvg/contracts";

/**
 * A diagnostic item as the Plane-style workspace sees it: one row, card or
 * calendar entry. It merges the scoped request listing (every role can read
 * it) with the richer queue projection when the user also works that queue.
 */
export interface WorkItem {
  id: string;
  requestId: string;
  requestCode: string;
  requesterId?: string;
  /** 1-based position among same-sector items of the request, when there are several. */
  sectorOrdinal?: number;
  status: ItemState;
  priority: Priority;
  workflowType: WorkflowType;
  departmentCode: string;
  version: number;
  dueAt: string;
  createdAt: string;
  overdue: boolean;
  nextAction?: string;
  currentResultId?: string;
  currentSampleId?: string;
  procedureId?: string;
  procedureVersion?: number;
  patient: { id: string; displayName: string; species: string; externalId: string; breed?: string; ownerLabel?: string };
  service: { id: string; code: string; name: string };
  operationalContext?: OperationalContext;
}

/** Shape of one entry of `GET /diagnostic-requests` (RequestView). */
export interface RequestListEntry {
  id: string;
  requestCode: string;
  priority: Priority;
  createdAt: string;
  updatedAt?: string;
  requesterId?: string;
  requestingDepartmentCode?: string;
  patient: Pick<Patient, "id" | "displayName" | "species" | "externalId"> & Partial<Pick<Patient, "breed" | "ownerLabel">>;
  items: Array<{
    id: string;
    requestId: string;
    status: ItemState;
    priority: Priority;
    workflowType: WorkflowType;
    departmentCode: string;
    version: number;
    dueAt: string;
    requestedAt?: string;
    currentResultId?: string;
    currentSampleId?: string;
    procedureId?: string;
    procedureVersion?: number;
    service: { id: string; code: string; name: string };
  }>;
}

const terminalStates = new Set<ItemState>(TERMINAL_ITEM_STATES);

export function isTerminal(status: ItemState): boolean {
  return terminalStates.has(status);
}

export function isOverdue(item: Pick<WorkItem, "status" | "dueAt">, now = Date.now()): boolean {
  const due = Date.parse(item.dueAt);
  return !isTerminal(item.status) && Number.isFinite(due) && due < now;
}

export function fromRequests(requests: RequestListEntry[], now = Date.now()): WorkItem[] {
  return requests.flatMap((request) => request.items.map((item) => {
    const siblings = request.items.filter((entry) => entry.departmentCode === item.departmentCode);
    const workItem: WorkItem = {
      id: item.id,
      requestId: request.id,
      requestCode: request.requestCode,
      requesterId: request.requesterId,
      sectorOrdinal: siblings.length > 1 ? siblings.indexOf(item) + 1 : undefined,
      status: item.status,
      priority: item.priority,
      workflowType: item.workflowType,
      departmentCode: item.departmentCode,
      version: item.version,
      dueAt: item.dueAt,
      createdAt: item.requestedAt ?? request.createdAt,
      overdue: false,
      currentResultId: item.currentResultId,
      currentSampleId: item.currentSampleId,
      procedureId: item.procedureId,
      procedureVersion: item.procedureVersion,
      patient: { id: request.patient.id, displayName: request.patient.displayName, species: request.patient.species, externalId: request.patient.externalId, breed: request.patient.breed, ownerLabel: request.patient.ownerLabel },
      service: { id: item.service.id, code: item.service.code, name: item.service.name }
    };
    workItem.overdue = isOverdue(workItem, now);
    workItem.nextAction = derivedNextAction(workItem);
    return workItem;
  }));
}

export function fromQueueItem(item: QueueItem, departmentCode: string): WorkItem {
  return {
    id: item.id,
    requestId: item.requestId,
    requestCode: item.requestCode,
    status: item.status,
    priority: item.priority,
    workflowType: item.workflowType,
    departmentCode,
    version: item.version,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
    overdue: item.overdue,
    nextAction: item.nextAction,
    currentResultId: item.currentResultId,
    currentSampleId: item.currentSampleId,
    procedureId: item.procedureId,
    procedureVersion: item.procedureVersion,
    patient: { ...item.patient },
    service: { ...item.service },
    operationalContext: item.operationalContext
  };
}

/** Queue projections are authoritative for the fields they carry. */
export function mergeWorkItems(base: WorkItem[], enriched: WorkItem[]): WorkItem[] {
  const byId = new Map(base.map((item) => [item.id, item]));
  for (const item of enriched) {
    const current = byId.get(item.id);
    if (current && current.version > item.version) continue;
    byId.set(item.id, current ? { ...current, ...item, patient: { ...current.patient, ...item.patient }, departmentCode: current.departmentCode || item.departmentCode, createdAt: current.createdAt || item.createdAt } : item);
  }
  return [...byId.values()];
}

/** What happens next, in plain words, when the queue projection is not visible to this user. */
export function derivedNextAction(item: Pick<WorkItem, "status" | "workflowType">): string | undefined {
  switch (item.status) {
    case "REQUESTED": return item.workflowType === "LABORATORY" ? "Receber amostra" : item.workflowType === "ULTRASOUND" ? "Agendar exame" : "Realizar procedimento";
    case "RECEIVED": return "Iniciar processamento";
    case "SCHEDULED": return "Realizar procedimento";
    case "IN_PROGRESS": return item.workflowType === "LABORATORY" ? "Registrar resultado" : "Concluir procedimento";
    case "AWAITING_REPORT": return "Emitir laudo";
    case "RESULT_AVAILABLE": return "Revisar resultado";
    case "REVIEWED": return "Concluir exame";
    case "RECOLLECTION_REQUIRED": return "Nova coleta de amostra";
    case "FAILED": return "Tratar pendência";
    case "RESULT_VOIDED": return "Reemitir resultado";
    default: return undefined;
  }
}

/* ---------- Labels ---------- */

export const STATE_LABELS: Record<ItemState, string> = {
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

/** Plane-style state groups: each ItemState belongs to one visual family. */
export type StateGroup = "backlog" | "unstarted" | "started" | "review" | "completed" | "attention" | "cancelled";

export const STATE_GROUP: Record<ItemState, StateGroup> = {
  REQUESTED: "unstarted",
  RECEIVED: "started",
  SCHEDULED: "unstarted",
  IN_PROGRESS: "started",
  AWAITING_REPORT: "started",
  RESULT_AVAILABLE: "review",
  REVIEWED: "completed",
  COMPLETED: "completed",
  RECOLLECTION_REQUIRED: "attention",
  FAILED: "attention",
  CANCELLED: "cancelled",
  REJECTED: "cancelled",
  RESULT_VOIDED: "attention"
};

/** Fraction of the state circle that is filled, Plane-style. */
export const STATE_PROGRESS: Record<ItemState, number> = {
  REQUESTED: 0,
  SCHEDULED: 0.25,
  RECEIVED: 0.25,
  IN_PROGRESS: 0.5,
  AWAITING_REPORT: 0.75,
  RESULT_AVAILABLE: 0.9,
  REVIEWED: 1,
  COMPLETED: 1,
  RECOLLECTION_REQUIRED: 0,
  FAILED: 0,
  RESULT_VOIDED: 0,
  CANCELLED: 0,
  REJECTED: 0
};

/** Workflow order used for columns and groups. */
export const STATE_ORDER: ItemState[] = ["REQUESTED", "SCHEDULED", "RECEIVED", "IN_PROGRESS", "AWAITING_REPORT", "RECOLLECTION_REQUIRED", "FAILED", "RESULT_VOIDED", "RESULT_AVAILABLE", "REVIEWED", "COMPLETED", "CANCELLED", "REJECTED"];

export const PRIORITY_LABELS: Record<Priority, string> = { EMERGENCY: "Emergência", URGENT: "Urgente", ROUTINE: "Rotina" };
export const PRIORITY_ORDER: Priority[] = ["EMERGENCY", "URGENT", "ROUTINE"];
const priorityRank: Record<Priority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };

export const DEPARTMENT_LABELS: Record<string, string> = {
  INPATIENT: "Internação",
  LABORATORY: "Laboratório",
  RADIOLOGY: "Radiologia",
  ULTRASOUND: "Ultrassom",
  OPERATIONS: "Operações",
  IT: "Tecnologia"
};

/** Short project-style identifiers, like Plane's "WEB" or "API". */
export const DEPARTMENT_KEYS: Record<string, string> = { INPATIENT: "INT", LABORATORY: "LAB", RADIOLOGY: "RX", ULTRASOUND: "US", OPERATIONS: "OPS", IT: "TI" };

export const CLINICAL_DEPARTMENTS = ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] as const;

export function departmentLabel(code: string): string {
  return DEPARTMENT_LABELS[code] ?? code.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

export function departmentKey(code: string): string {
  return DEPARTMENT_KEYS[code] ?? code.slice(0, 3).toUpperCase();
}

/** Plane shows "WEB-42"; we show the sector key plus the request sequence. */
export function workItemKey(item: Pick<WorkItem, "departmentCode" | "requestCode" | "sectorOrdinal">): string {
  const sequence = item.requestCode.split("-").at(-1) ?? item.requestCode;
  return `${departmentKey(item.departmentCode)}-${sequence}${item.sectorOrdinal ? `.${item.sectorOrdinal}` : ""}`;
}

export function workItemTitle(item: Pick<WorkItem, "patient" | "service">): string {
  return `${item.patient.displayName} — ${item.service.name}`;
}

/* ---------- Filters, grouping and ordering ---------- */

export type GroupBy = "status" | "priority" | "department" | "service" | "patient" | "none";
export type OrderBy = "due" | "priority" | "recent" | "patient";
export type Layout = "list" | "board" | "calendar" | "spreadsheet";
export type DisplayProperty = "key" | "state" | "priority" | "patient" | "department" | "due" | "nextAction" | "owner";

export const DISPLAY_PROPERTY_LABELS: Record<DisplayProperty, string> = {
  key: "ID",
  state: "Estado",
  priority: "Prioridade",
  patient: "Paciente",
  department: "Setor",
  due: "Prazo",
  nextAction: "Próxima ação",
  owner: "Responsável"
};

export const GROUP_BY_LABELS: Record<GroupBy, string> = { status: "Estado", priority: "Prioridade", department: "Setor", service: "Exame", patient: "Paciente", none: "Nenhum" };
export const ORDER_BY_LABELS: Record<OrderBy, string> = { due: "Prazo mais próximo", priority: "Prioridade", recent: "Mais recentes", patient: "Paciente (A–Z)" };
export const LAYOUT_LABELS: Record<Layout, string> = { list: "Lista", board: "Quadro", calendar: "Calendário", spreadsheet: "Planilha" };

export interface WorkItemFilters {
  search: string;
  states: ItemState[];
  priorities: Priority[];
  departments: string[];
  services: string[];
  overdueOnly: boolean;
  hideClosed: boolean;
}

export const EMPTY_FILTERS: WorkItemFilters = { search: "", states: [], priorities: [], departments: [], services: [], overdueOnly: false, hideClosed: false };

export interface DisplayOptions {
  layout: Layout;
  groupBy: GroupBy;
  orderBy: OrderBy;
  properties: DisplayProperty[];
  showEmptyGroups: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  layout: "list",
  groupBy: "status",
  orderBy: "due",
  properties: ["key", "state", "priority", "department", "due", "owner"],
  showEmptyGroups: false
};

export function activeFilterCount(filters: WorkItemFilters): number {
  return filters.states.length + filters.priorities.length + filters.departments.length + filters.services.length + (filters.overdueOnly ? 1 : 0) + (filters.hideClosed ? 1 : 0);
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

export function applyFilters(items: WorkItem[], filters: WorkItemFilters): WorkItem[] {
  const query = normalize(filters.search.trim());
  return items.filter((item) => {
    if (filters.states.length && !filters.states.includes(item.status)) return false;
    if (filters.priorities.length && !filters.priorities.includes(item.priority)) return false;
    if (filters.departments.length && !filters.departments.includes(item.departmentCode)) return false;
    if (filters.services.length && !filters.services.includes(item.service.code)) return false;
    if (filters.overdueOnly && !item.overdue) return false;
    if (filters.hideClosed && isTerminal(item.status)) return false;
    if (query && ![item.patient.displayName, item.patient.externalId, item.service.name, item.requestCode, workItemKey(item)].some((value) => normalize(value).includes(query))) return false;
    return true;
  });
}

export function sortItems(items: WorkItem[], orderBy: OrderBy): WorkItem[] {
  const due = (item: WorkItem) => Date.parse(item.dueAt) || Number.MAX_SAFE_INTEGER;
  return [...items].sort((left, right) => {
    if (orderBy === "priority") return priorityRank[left.priority] - priorityRank[right.priority] || due(left) - due(right);
    if (orderBy === "recent") return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (orderBy === "patient") return left.patient.displayName.localeCompare(right.patient.displayName, "pt-BR") || due(left) - due(right);
    return Number(right.overdue) - Number(left.overdue) || due(left) - due(right) || priorityRank[left.priority] - priorityRank[right.priority];
  });
}

export interface WorkItemGroup {
  id: string;
  label: string;
  /** What the group header renders as its icon. */
  kind: "state" | "priority" | "department" | "service" | "patient" | "all";
  value: string;
  items: WorkItem[];
}

export function groupItems(items: WorkItem[], groupBy: GroupBy, showEmpty: boolean, scope: { departments: string[] }): WorkItemGroup[] {
  if (groupBy === "none") return [{ id: "all", label: "Todos os exames", kind: "all", value: "all", items }];
  if (groupBy === "status") {
    const base = showEmpty ? STATE_ORDER : STATE_ORDER.filter((state) => items.some((item) => item.status === state));
    return base.map((state) => ({ id: state, label: STATE_LABELS[state], kind: "state", value: state, items: items.filter((item) => item.status === state) }));
  }
  if (groupBy === "priority") {
    const base = showEmpty ? PRIORITY_ORDER : PRIORITY_ORDER.filter((priority) => items.some((item) => item.priority === priority));
    return base.map((priority) => ({ id: priority, label: PRIORITY_LABELS[priority], kind: "priority", value: priority, items: items.filter((item) => item.priority === priority) }));
  }
  if (groupBy === "department") {
    const codes = Array.from(new Set([...(showEmpty ? scope.departments : []), ...items.map((item) => item.departmentCode)]));
    return codes.sort((a, b) => departmentLabel(a).localeCompare(departmentLabel(b), "pt-BR")).map((code) => ({ id: code, label: departmentLabel(code), kind: "department", value: code, items: items.filter((item) => item.departmentCode === code) }));
  }
  const keyOf = groupBy === "service" ? (item: WorkItem) => item.service.code : (item: WorkItem) => item.patient.id;
  const labelOf = groupBy === "service" ? (item: WorkItem) => item.service.name : (item: WorkItem) => item.patient.displayName;
  const groups = new Map<string, WorkItemGroup>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? { id: key, label: labelOf(item), kind: groupBy, value: key, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/* ---------- Dates ---------- */

const dueFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
const dueTimeFormatter = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function formatDue(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem prazo";
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay) return `Hoje, ${dueTimeFormatter.format(date)}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Amanhã, ${dueTimeFormatter.format(date)}`;
  return dueFormatter.format(date).replace(".", "");
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
