import { z } from "zod";
import { DEPARTMENT_TYPES } from "@cvg/contracts";
const version = z.number().int().positive().max(999_999_999_999_999).optional();
const name = z.string().trim().min(1).refine((value) => Array.from(value).length <= 120);
const userId = z.string().min(1).max(100);
export const departmentCreateSchema = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/), name, type: z.enum(DEPARTMENT_TYPES) }).strict();
export const departmentPatchSchema = z.object({ name: name.optional(), type: z.enum(DEPARTMENT_TYPES).optional(), active: z.literal(true).optional(), expectedVersion: version }).strict();
export const departmentDeactivateSchema = z.object({ expectedVersion: version }).strict();
export const departmentMembersSchema = z.object({ memberUserIds: z.array(userId).max(500), responsibleUserId: userId.nullable().optional(), expectedVersion: version }).strict();
