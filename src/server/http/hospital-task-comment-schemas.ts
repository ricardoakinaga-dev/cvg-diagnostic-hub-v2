import { z } from "zod";
const body = z.string().trim().min(1).max(4000); const expectedVersion = z.number().int().positive();
const mentionedUserIds = z.array(z.string().min(1).max(100)).max(20).refine((values) => new Set(values).size === values.length).optional();
export const hospitalTaskCommentCreateSchema = z.object({ body, mentionedUserIds, expectedVersion }).strict();
export const hospitalTaskCommentPatchSchema = hospitalTaskCommentCreateSchema;
export const hospitalTaskCommentDeleteSchema = z.object({ reason: z.string().trim().min(1).max(500).optional(), expectedVersion }).strict();
export const hospitalTaskCommentFiltersSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() }).strict();
