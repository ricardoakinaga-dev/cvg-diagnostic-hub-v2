import type { AuditEntity, AuditEvent, AuditScope, DiagnosticRequest, StateStore, StoreState, User } from "../domain/models";
import { managerCanAccessDepartment } from "../security/authorization";
import { auditEventDepartmentCode, auditEventItemIds, canViewItem, canViewManagementAudit, canViewRequest, itemFor, requestForAuditEvent } from "./service-common";

// The existing audit policies resolve resources from this identity only; event
// metadata, actor and event type do not affect their visibility decisions.
function eventForEntity(entity: AuditEntity): AuditEvent {
  return { ...entity, id: "", eventType: "", correlationId: "", metadata: {}, occurredAt: "" };
}

function clinicalEntities(state: StoreState): AuditEntity[] {
  const collections = [
    ["DiagnosticRequest", state.requests],
    ["DiagnosticRequestItem", state.items],
    ["Sample", state.samples],
    ["Result", state.results],
    ["ResultVersion", state.resultVersions],
    ["Procedure", state.procedures],
    ["ProcedureSchedule", state.schedules],
    ["Attachment", state.attachments]
  ] as const;
  return collections.flatMap(([entityType, entries]) => entries.map(({ id }) => ({ entityType, entityId: id })));
}

function resolvedClinicalEntities(state: StoreState) {
  return clinicalEntities(state).flatMap((entity) => {
    const event = eventForEntity(entity);
    const request = requestForAuditEvent(state, event);
    return request ? [{ entity, event, request }] : [];
  });
}

export function auditScopeForActor(state: StoreState, actor: User): AuditScope {
  const resolved = resolvedClinicalEntities(state);
  const entities = resolved.filter(({ event, request }) => {
    const departmentCode = auditEventDepartmentCode(state, event);
    if (actor.role === "MANAGER" && departmentCode && !managerCanAccessDepartment(actor, departmentCode)) return false;
    return canViewRequest(state, actor, request) && auditEventItemIds(state, event).every((itemId) => canViewItem(state, actor, itemFor(state, itemId)));
  }).map(({ entity }) => entity);

  if (actor.role === "ADMIN") return { entities, unresolved: { resolvedEntities: resolved.map(({ entity }) => entity) } };
  if (actor.role === "MANAGER") {
    const managementEntities = [
      ...state.users.map(({ id }) => ({ entityType: "User", entityId: id })),
      ...state.services.map(({ id }) => ({ entityType: "DiagnosticService", entityId: id }))
    ];
    entities.push(...managementEntities.filter((entity) => canViewManagementAudit(state, actor, eventForEntity(entity))));
    return { entities, entityTypes: ["ReasonCode"] };
  }
  return { entities };
}

export function requestAuditScope(state: StoreState, actor: User, request: DiagnosticRequest): AuditScope {
  const visibleItemIds = new Set(request.itemIds.filter((itemId) => canViewItem(state, actor, itemFor(state, itemId))));
  return patientAuditScope(state, request.patientId, new Set([request.id]), visibleItemIds);
}

export function patientAuditScope(state: StoreState, patientId: string, requestIds: ReadonlySet<string>, itemIds: ReadonlySet<string>): AuditScope {
  return {
    entities: resolvedClinicalEntities(state)
      .filter(({ event, request }) => request.patientId === patientId && requestIds.has(request.id) && auditEventItemIds(state, event).every((itemId) => itemIds.has(itemId)))
      .map(({ entity }) => entity)
  };
}

// The workspace response contains all scoped history, including requests beyond
// its request page. Keep that contract while bounding each historical read.
export async function readPatientAuditEvents(store: StateStore, scope: AuditScope): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: { occurredAt: string; id: string } | undefined;
  while (true) {
    const page = await store.readAuditEvents({ scope, order: "asc", limit: 100, cursor });
    events.push(...page.items);
    if (!page.hasMore) return events;
    const last = page.items.at(-1);
    if (!last || (cursor && last.occurredAt === cursor.occurredAt && last.id === cursor.id)) throw new Error("AUDIT_READ_CURSOR_NOT_ADVANCING");
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }
}
