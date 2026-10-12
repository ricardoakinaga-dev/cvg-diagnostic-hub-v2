import type { WorkNotification, WorkNotificationPreference, WorkNotificationView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { WorkNotificationArchiveInput, WorkNotificationFilters, WorkNotificationPreferenceInput, WorkNotificationReadInput } from "./work-activity-types";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessResource } from "../security/authorization";
import { pagePlannerObjects, validateTaskBody } from "./hospital-task-common";
import { resolveWorkActivity } from "./work-activity-policy";
import { workNotificationArchiveSchema, workNotificationFiltersSchema, workNotificationPreferenceSchema, workNotificationReadSchema } from "../http/work-activity-schemas";

export function workNotificationView(state: StoreState, actor: User, notification: WorkNotification): WorkNotificationView {
  if (notification.userId !== actor.id) findOrThrowScoped(undefined);
  requirePermission(actor, "work_notification.view", {});
  const target = resolveWorkActivity(state, actor, notification.targetType, notification.targetId);
  return { notification, target, permissions: (["work_notification.read", "work_notification.archive"] as const).filter((permission) => canAccessResource(actor, permission, {})) };
}
function visibleNotifications(state: StoreState, actor: User): WorkNotificationView[] {
  return state.workNotifications.filter((entry) => entry.userId === actor.id).flatMap((entry) => { try { return [workNotificationView(state, actor, entry)]; } catch { return []; } });
}
export function createWorkNotificationService({ store }: ApplicationServiceContext) {
  return {
    async listWorkNotifications(actor: User, filters: WorkNotificationFilters = {}) {
      validateTaskBody(workNotificationFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "work_notification.view", {});
      const visible = visibleNotifications(state, current); const rows = visible.filter(({ notification }) => (filters.includeArchived || !notification.archivedAt) && (!filters.unreadOnly || !notification.readAt));
      const page = pagePlannerObjects(rows.map((entry) => ({ ...entry, id: entry.notification.id, createdAt: entry.notification.createdAt })), filters);
      return { ...page, unread: visible.filter(({ notification }) => !notification.readAt && !notification.archivedAt).length, items: page.items.map(({ notification, target, permissions }) => ({ notification, target, permissions })) };
    },
    async getWorkNotificationPreferences(actor: User) {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "work_notification.preferences.manage", {});
      return state.workNotificationPreferences.find((entry) => entry.userId === current.id) ?? { userId: current.id, mutedEvents: [], version: 0 };
    },
    async putWorkNotificationPreferences(actor: User, input: WorkNotificationPreferenceInput): Promise<WorkNotificationPreference> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "work_notification.preferences.manage", {}); validateTaskBody(workNotificationPreferenceSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const previous = state.workNotificationPreferences.find((entry) => entry.userId === current.id); const scope = "PUT:/work-notifications/preferences";
        const replay = withIdempotency<WorkNotificationPreference>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: findOrThrowScoped(previous) };
        ensureExpectedVersion(previous?.version ?? 0, input.expectedVersion); const timestamp = now();
        const preference: WorkNotificationPreference = { id: previous?.id ?? id("work-notification-preference"), userId: current.id, mutedEvents: [...input.mutedEvents], version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
        const next = { ...state, workNotificationPreferences: previous ? state.workNotificationPreferences.map((entry) => entry.id === previous.id ? preference : entry) : [...state.workNotificationPreferences, preference], auditEvents: [...state.auditEvents, createAudit("WorkNotificationPreferencesUpdated", current.id, "WorkNotificationPreference", preference.id, input.correlationId ?? id("corr"), String(previous?.version ?? 0), String(preference.version), { privateMetadataOnly: true })], outbox: [...state.outbox, createOutbox("WorkNotificationPreferencesUpdated", "WorkNotificationPreference", preference.id, input.correlationId ?? id("corr"), { version: preference.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, preference, { input }), result: preference };
      });
    },
    async markWorkNotificationsRead(actor: User, input: WorkNotificationReadInput): Promise<{ marked: number }> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "work_notification.read", {}); requirePermission(current, "work_notification.view", {}); validateTaskBody(workNotificationReadSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const visible = visibleNotifications(state, current); const ids = new Set(input.all ? visible.filter((entry) => !entry.notification.archivedAt).map((entry) => entry.notification.id) : input.notificationIds);
        if (!input.all) for (const notificationId of ids) workNotificationView(state, current, findOrThrowScoped(state.workNotifications.find((entry) => entry.id === notificationId)));
        const scope = "POST:/work-notifications/read"; const replay = withIdempotency<{ marked: number }>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: replay.existing! };
        const timestamp = now(); const read = input.read !== false; let marked = 0; const notifications = state.workNotifications.map((entry) => { if (entry.userId !== current.id || !ids.has(entry.id) || Boolean(entry.readAt) === read) return entry; marked++; return { ...entry, readAt: read ? timestamp : undefined, version: entry.version + 1 }; });
        const next = { ...state, workNotifications: notifications, auditEvents: [...state.auditEvents, createAudit("WorkNotificationsRead", current.id, "UserWorkInbox", current.id, input.correlationId ?? id("corr"), undefined, undefined, { marked, readReceiptOnly: true })], outbox: [...state.outbox, createOutbox("WorkNotificationsRead", "UserWorkInbox", current.id, input.correlationId ?? id("corr"), {})] }; const result = { marked };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async setWorkNotificationArchived(actor: User, notificationId: string, input: WorkNotificationArchiveInput): Promise<WorkNotificationView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "work_notification.archive", {}); validateTaskBody(workNotificationArchiveSchema, input); requireIdempotencyKey(input.idempotencyKey); const previous = findOrThrowScoped(state.workNotifications.find((entry) => entry.id === notificationId)); workNotificationView(state, current, previous);
        const scope = `POST:/work-notifications/${notificationId}/archive`; const replay = withIdempotency<WorkNotificationView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: workNotificationView(state, current, previous) };
        ensureExpectedVersion(previous.version, input.expectedVersion); const notification = { ...previous, archivedAt: input.archived ? now() : undefined, version: previous.version + 1 }; const result = workNotificationView(state, current, notification);
        const next = { ...state, workNotifications: state.workNotifications.map((entry) => entry.id === notificationId ? notification : entry), auditEvents: [...state.auditEvents, createAudit("WorkNotificationArchiveChanged", current.id, "WorkNotification", notificationId, input.correlationId ?? id("corr"), String(previous.version), String(notification.version), { archived: input.archived, privateMetadataOnly: true })], outbox: [...state.outbox, createOutbox("WorkNotificationArchiveChanged", "WorkNotification", notificationId, input.correlationId ?? id("corr"), { version: notification.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
