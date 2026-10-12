import type { WorkActivityTargetType, WorkNotificationEvent } from "@cvg/contracts";
import type { StoreState } from "../domain/models";
import { canAccessResource } from "../security/authorization";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { createOutbox, id } from "./service-common";
import { canResolveWorkActivity } from "./work-activity-policy";

export function workActivityFollowers(state: StoreState, targetType: WorkActivityTargetType, targetId: string): string[] {
  return state.workActivityPreferences.filter((entry) => entry.targetType === targetType && entry.targetId === targetId && entry.following).map((entry) => entry.userId);
}
type NotificationDelivery = { sourceKey: string; targetType: WorkActivityTargetType; targetId: string; eventType: WorkNotificationEvent; recipientUserIds: string[]; createdAt: string };
function eligibleNotificationRecipients(state: StoreState, input: NotificationDelivery): string[] {
  return [...new Set(input.recipientUserIds)].filter((userId) => {
    const user = state.users.find((entry) => entry.id === userId); if (!user?.active || user.mustChangePassword) return false;
    const current = hydrateUserPermissions(state, user);
    return canAccessResource(current, "work_notification.view", {}) && canResolveWorkActivity(state, current, input.targetType, input.targetId) && !state.workNotificationPreferences.find((entry) => entry.userId === userId)?.mutedEvents.includes(input.eventType);
  });
}

/** Delivery is an internal inbox reference, never an acknowledgement of clinical work. */
export function appendWorkNotifications(state: StoreState, input: NotificationDelivery): StoreState {
  const notifications = [...state.workNotifications];
  const outbox = [...state.outbox];
  for (const userId of eligibleNotificationRecipients(state, input)) {
    if (notifications.some((entry) => entry.userId === userId && entry.sourceKey === input.sourceKey)) continue;
    const notificationId = id("work-notification"); notifications.push({ id: notificationId, sourceKey: input.sourceKey, userId, targetType: input.targetType, targetId: input.targetId, eventType: input.eventType, version: 1, createdAt: input.createdAt });
    outbox.push(createOutbox("WorkNotificationCreated", "WorkNotification", notificationId, id("corr"), { notificationId, version: 1 }));
  }
  return { ...state, workNotifications: notifications, outbox };
}

export function appendDueTaskNotifications(state: StoreState, asOf: string, limit = 100): StoreState {
  if (!Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) > Date.now() || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_WORK_NOTIFICATION_WINDOW");
  let next = state;
  let deliveredTasks = 0;
  for (const task of state.hospitalTasks.filter((entry) => !entry.isDraft && !entry.archivedAt && !entry.draftCancelledAt && entry.plannedEndAt && entry.plannedEndAt <= asOf && !["COMPLETED", "CANCELLED"].includes(entry.phase)).sort((a, b) => a.plannedEndAt!.localeCompare(b.plannedEndAt!) || a.id.localeCompare(b.id))) {
    const delivery: NotificationDelivery = { sourceKey: `task-due:${task.id}:${task.plannedEndAt}`, targetType: "HOSPITAL_TASK", targetId: task.id, eventType: "TASK_DUE", recipientUserIds: [task.responsibleUserId, ...task.executorTeamUserIds, ...workActivityFollowers(next, "HOSPITAL_TASK", task.id)].filter((entry): entry is string => Boolean(entry)), createdAt: asOf };
    if (!eligibleNotificationRecipients(next, delivery).some((userId) => !next.workNotifications.some((entry) => entry.userId === userId && entry.sourceKey === delivery.sourceKey))) continue;
    next = appendWorkNotifications(next, delivery); if (++deliveredTasks >= limit) break;
  }
  return next;
}
