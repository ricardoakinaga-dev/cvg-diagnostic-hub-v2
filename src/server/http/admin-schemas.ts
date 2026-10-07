import { z } from "zod";
import { ROLES } from "@cvg/contracts";

const codePointLength = (value: string) => Array.from(value).length;
const boundedString = (minimum: number, maximum: number) => z.string().refine((value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum);
const normalizedText = (minimum: number, maximum: number) => z.string().transform((value) => value.trim()).refine((value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum);
const catalogCodeSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,59}$/);
const departmentCodeSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/);
const expectedVersionSchema = z.number().int().positive().max(999_999_999_999_999);

export const reauthenticationSchema = z.object({ password: boundedString(1, 200) }).strict();
export const initialPasswordSchema = z.object({ password: boundedString(12, 200) }).strict();
const serviceCodesSchema = z.array(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,59}$/)).max(200).optional();
const managedDepartmentCodesSchema = z.array(departmentCodeSchema).max(20).optional();
export const userRoleSchema = z.object({ role: z.enum(ROLES), departmentCode: departmentCodeSchema, managedDepartmentCodes: managedDepartmentCodesSchema, serviceCodes: serviceCodesSchema, active: z.boolean().optional(), expectedVersion: expectedVersionSchema.optional(), reason: normalizedText(1, 500).optional(), confirm: z.literal(true).optional() }).strict();
export const userCreateSchema = z.object({ email: z.string().email().refine((value) => codePointLength(value) <= 320), displayName: normalizedText(2, 160), password: boundedString(12, 200).optional(), role: z.enum(ROLES), departmentCode: departmentCodeSchema.optional(), managedDepartmentCodes: managedDepartmentCodesSchema, serviceCodes: serviceCodesSchema, timezone: normalizedText(1, 80).optional(), reason: normalizedText(1, 500).optional(), confirm: z.literal(true).optional() }).strict();
export const userDeactivateSchema = z.object({ expectedVersion: expectedVersionSchema.optional(), reason: normalizedText(1, 500).optional(), confirm: z.literal(true).optional() }).strict();
export const userPasswordSchema = z.object({ expectedVersion: expectedVersionSchema.optional() }).strict();
export const sessionRevokeSchema = z.object({ reason: normalizedText(1, 500).optional(), confirm: z.literal(true).optional() }).strict();
export const deadLetterCommandSchema = z.object({ reason: normalizedText(1, 500).optional(), confirm: z.literal(true).optional() }).strict();


export const serviceCreateSchema = z.object({
  code: catalogCodeSchema,
  name: normalizedText(1, 120),
  category: z.enum(["LABORATORY", "IMAGING"]),
  departmentCode: departmentCodeSchema,
  workflowType: z.enum(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]),
  requiresSample: z.boolean(),
  requiresSchedule: z.boolean(),
  allowsAttachment: z.boolean(),
  resultSchema: z.enum(["NUMERIC_PANEL", "NARRATIVE"]),
  duplicateOfServiceId: z.string().min(1).max(120).optional(),
  slaHours: z.object({ ROUTINE: z.number().positive().max(720), URGENT: z.number().positive().max(720), EMERGENCY: z.number().positive().max(720) }).strict()
}).strict();
export const servicePatchSchema = z.object({ name: normalizedText(1, 120).optional(), category: z.enum(["LABORATORY", "IMAGING"]).optional(), departmentCode: departmentCodeSchema.optional(), workflowType: z.enum(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]).optional(), requiresSample: z.boolean().optional(), requiresSchedule: z.boolean().optional(), active: z.boolean().optional(), allowsAttachment: z.boolean().optional(), resultSchema: z.enum(["NUMERIC_PANEL", "NARRATIVE"]).optional(), slaHours: z.object({ ROUTINE: z.number().positive().max(720), URGENT: z.number().positive().max(720), EMERGENCY: z.number().positive().max(720) }).strict().optional(), expectedVersion: expectedVersionSchema.optional() }).strict();
