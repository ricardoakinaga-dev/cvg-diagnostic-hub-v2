import type { WorkActivityTargetType, WorkNotificationEvent } from "@cvg/contracts";
import type { CommandMeta } from "./service-types";
export type WorkActivityPreferenceInput = CommandMeta & { targetType: WorkActivityTargetType; targetId: string; favorite?: boolean; favoriteGroup?: string | null; following?: boolean; privateNote?: string | null; opened?: true; hiddenFromRecents?: boolean };
export interface WorkActivityPreferenceFilters { targetType?: WorkActivityTargetType; targetId?: string; mode?: "ALL" | "FAVORITES" | "RECENTS" | "FOLLOWING" | "NOTES"; limit?: number; cursor?: string }
export interface WorkNotificationFilters { includeArchived?: boolean; unreadOnly?: boolean; limit?: number; cursor?: string }
export type WorkNotificationReadInput = CommandMeta & { notificationIds?: string[]; all?: true; read?: boolean };
export type WorkNotificationArchiveInput = CommandMeta & { archived: boolean };
export type WorkNotificationPreferenceInput = CommandMeta & { mutedEvents: WorkNotificationEvent[] };
