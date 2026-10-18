import { z } from "zod";
export const hospitalCareExecuteSchema = z.object({ expectedVersion: z.number().int().positive(), confirm: z.literal(true), clinicalRecordReference: z.string().trim().min(1).max(500), note: z.string().trim().min(1).max(2000).optional() }).strict();
export type HospitalCareExecuteInput = z.input<typeof hospitalCareExecuteSchema> & { idempotencyKey?: string; correlationId?: string };
