import type { AuditEvent, AuditReadPage, AuditReadQuery } from "../domain/models";

export function assertAuditReadQuery(query: AuditReadQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000 || !["asc", "desc"].includes(query.order)) {
    throw new Error("AUDIT_READ_QUERY_INVALID");
  }
  if (query.cursor && !Number.isFinite(Date.parse(query.cursor.occurredAt))) throw new Error("AUDIT_READ_CURSOR_INVALID");
}

export function auditPage(events: AuditEvent[], query: AuditReadQuery): AuditReadPage {
  assertAuditReadQuery(query);
  const keys = new Set(query.scope.entities.map((entity) => JSON.stringify([entity.entityType, entity.entityId])));
  const resolved = new Set(query.scope.unresolved?.resolvedEntities.map((entity) => JSON.stringify([entity.entityType, entity.entityId])));
  const allowed = events.filter((event) => {
    const key = JSON.stringify([event.entityType, event.entityId]);
    return keys.has(key) || query.scope.entityTypes?.includes(event.entityType) || (query.scope.unresolved && !resolved.has(key));
  }).sort((left, right) => (query.order === "asc" ? 1 : -1) * left.occurredAt.localeCompare(right.occurredAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const cursor = query.cursor;
  const after = cursor ? allowed.filter((event) => (query.order === "asc" ? event.occurredAt > cursor.occurredAt : event.occurredAt < cursor.occurredAt) || (event.occurredAt === cursor.occurredAt && event.id > cursor.id)) : allowed;
  return { items: structuredClone(after.slice(0, query.limit)), total: allowed.length, hasMore: after.length > query.limit };
}
