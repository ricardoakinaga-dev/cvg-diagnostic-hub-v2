import type { AuditScope, StateStore, StoreState, User } from "../domain/models";
import { findById, requestsForPatient } from "../domain/state-index";
import { ApiError } from "../http/envelope";
import { patientAuditScope } from "./audit-read";
import { canViewItem, canViewRequest, itemFor, requireActiveUser, requirePatientPermission } from "./service-common";
import { decodeKeysetCursor, pageSize } from "./service-pagination";

const denied = () => new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);

function scopeFor(state: StoreState, actor: User, patientId: string): AuditScope {
  requirePatientPermission(state, actor, "patient.view", patientId);
  requirePatientPermission(state, actor, "diagnostic.timeline.view", patientId);
  if (!findById(state.patients, patientId)) throw denied();
  const requests = requestsForPatient(state, patientId).filter((request) => canViewRequest(state, actor, request));
  const requestIds = new Set(requests.map((request) => request.id));
  const itemIds = new Set(requests.flatMap((request) => request.itemIds).filter((id) => canViewItem(state, actor, itemFor(state, id))));
  return patientAuditScope(state, patientId, requestIds, itemIds);
}

function scopeKey(scope: AuditScope): string {
  return JSON.stringify(scope.entities?.map((entity) => `${entity.entityType}:${entity.entityId}`).sort() ?? []);
}

export async function getPatientTimeline(store: StateStore, actor: User, patientId: string, filters: { limit?: number; cursor?: string } = {}) {
  const state = await store.readState();
  const currentActor = requireActiveUser(state, actor);
  const scope = scopeFor(state, currentActor, patientId);
  const limit = pageSize(filters.limit);
  const cursor = decodeKeysetCursor<{ patientId: string; occurredAt: string; id: string }>(filters.cursor, (value) => value.patientId === patientId && typeof value.occurredAt === "string" && Number.isFinite(Date.parse(value.occurredAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
  const page = await store.readAuditEvents({ scope, order: "desc", limit, ...(cursor ? { cursor: { occurredAt: cursor.occurredAt, id: cursor.id } } : {}) });
  // I/O can interleave revocation or resource changes; never publish an earlier scope or its total afterwards.
  const finalState = await store.readState();
  const finalActor = requireActiveUser(finalState, currentActor);
  const finalScope = scopeFor(finalState, finalActor, patientId);
  if (finalActor.version !== currentActor.version || scopeKey(finalScope) !== scopeKey(scope)) throw denied();
  const items = page.items.map((event) => ({ ...event, metadata: { ...event.metadata } }));
  const last = items.at(-1);
  const nextCursor = last && page.hasMore ? Buffer.from(JSON.stringify({ patientId, occurredAt: last.occurredAt, id: last.id })).toString("base64url") : undefined;
  return { items, nextCursor, limit, total: page.total };
}
