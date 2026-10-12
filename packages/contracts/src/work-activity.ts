import type { Permission } from "./identity-permissions";
export const WORK_ACTIVITY_TARGETS = ["HOSPITAL_TASK", "HOSPITAL_PLAN", "HOSPITAL_SHIFT", "HOSPITAL_HANDOFF", "HOSPITAL_INTAKE", "CHECKLIST_TEMPLATE", "HOSPITAL_RECURRENCE", "HOSPITAL_DOCUMENT", "HOSPITAL_RESOURCE", "HOSPITAL_SERVICE", "DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST", "SAVED_PLANNER_VIEW", "DEPARTMENT"] as const;
export type WorkActivityTargetType = (typeof WORK_ACTIVITY_TARGETS)[number];
/** Private metadata. Every read resolves the original target against current access. */
export interface WorkActivityPreference {
  id: string; userId: string; targetType: WorkActivityTargetType; targetId: string;
  favorite: boolean; favoriteGroup?: string; following: boolean; privateNote?: string; lastOpenedAt?: string; hiddenFromRecents: boolean;
  version: number; createdAt: string; updatedAt: string;
}
export interface WorkActivityReference { targetType: WorkActivityTargetType; targetId: string; label: string; deepLink: string }
export interface WorkActivityPreferenceView { preference: WorkActivityPreference; target: WorkActivityReference }
export const WORK_NOTIFICATION_EVENTS = ["TASK_ASSIGNED", "TASK_CHANGED", "TASK_DUE", "TASK_COMMENTED", "TASK_MENTIONED", "HANDOFF_OFFERED", "HANDOFF_DECIDED", "PLAN_UPDATED", "RECURRENCE_BLOCKED", "DOCUMENT_PUBLISHED"] as const;
export type WorkNotificationEvent = (typeof WORK_NOTIFICATION_EVENTS)[number];
/** The notification stores an opaque reference, never patient names or message content. */
export interface WorkNotification {
  id: string; sourceKey: string; userId: string; targetType: WorkActivityTargetType; targetId: string;
  eventType: WorkNotificationEvent; readAt?: string; archivedAt?: string; version: number; createdAt: string;
}
export interface WorkNotificationView { notification: WorkNotification; target: WorkActivityReference; permissions: Permission[] }
export interface WorkNotificationPage { items: WorkNotificationView[]; total: number; unread: number; limit: number; nextCursor?: string }
export interface WorkNotificationPreference { id: string; userId: string; mutedEvents: WorkNotificationEvent[]; version: number; createdAt: string; updatedAt: string }
