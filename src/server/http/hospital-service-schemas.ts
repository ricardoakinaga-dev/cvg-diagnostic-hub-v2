import { z } from "zod";
import { HOSPITAL_SERVICE_KINDS } from "@cvg/contracts";

const code = z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(text(100)).max(500).refine((values) => new Set(values).size === values.length, "Os vínculos não podem estar repetidos.");
const fields = { name: text(160), description: text(1000).optional(), kind: z.enum(HOSPITAL_SERVICE_KINDS), departmentCode: code, teamUserIds: ids.default([]), resourceIds: ids.default([]), active: z.boolean().default(true) };
export const hospitalServiceCreateSchema = z.object({ code, ...fields }).strict();
export const hospitalServicePatchSchema = z.object({ name: fields.name.optional(), description: text(1000).nullable().optional(), kind: fields.kind.optional(), departmentCode: code.optional(), teamUserIds: ids.optional(), resourceIds: ids.optional(), active: z.boolean().optional(), expectedVersion: z.number().int().positive() }).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), "Informe uma alteração no serviço.");
export const hospitalServiceImportSchema = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().optional() }).strict();
type CommandMetadata = { idempotencyKey?: string; correlationId?: string };
export type HospitalServiceCreateInput = z.input<typeof hospitalServiceCreateSchema> & CommandMetadata;
export type HospitalServicePatchInput = z.input<typeof hospitalServicePatchSchema> & CommandMetadata;
export type HospitalServiceImportInput = z.input<typeof hospitalServiceImportSchema> & CommandMetadata;
