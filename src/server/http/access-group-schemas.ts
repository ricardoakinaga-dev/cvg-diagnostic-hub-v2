import { z } from "zod";
import { PERMISSIONS as PERMISSION_CODES } from "@cvg/contracts";
const permission = z.enum(PERMISSION_CODES);
const permissions = z.array(permission).max(PERMISSION_CODES.length).refine((values) => new Set(values).size === values.length, "Permissões repetidas.");
const expectedVersion = z.number().int().positive().max(999_999_999_999_999);
const identifier = z.string().min(1).max(100);
const description = z.string().trim().min(1).max(160);
export const accessGroupCreateSchema = z.object({ code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{1,59}$/), description, permissions }).strict();
export const accessGroupPatchSchema = z.object({ description: description.optional(), permissions: permissions.optional(), active: z.boolean().optional(), expectedVersion, expectedImpactToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const userGroupAssignmentSchema = z.object({ accessGroupId: identifier, expectedGroupVersion: expectedVersion.optional(), expectedVersion }).strict();
export const effectiveAccessPreviewSchema = z.object({ accessGroupId: identifier.optional(), permissions: permissions.optional() }).strict();
export const patientGrantSchema = z.object({ patientId: identifier, active: z.boolean(), reason: z.string().trim().min(1).max(500), expectedVersion }).strict();

export const accessGroupImpactPreviewSchema = accessGroupPatchSchema.omit({ expectedImpactToken: true });
