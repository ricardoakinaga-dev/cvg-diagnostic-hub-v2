import type { CommandMeta } from "./service-types";
export type HospitalTaskCommentCreateInput = CommandMeta & { body: string; mentionedUserIds?: string[] };
export type HospitalTaskCommentPatchInput = CommandMeta & { body: string; mentionedUserIds?: string[] };
export type HospitalTaskCommentDeleteInput = CommandMeta & { reason?: string };
export interface HospitalTaskCommentFilters { limit?: number; cursor?: string }
