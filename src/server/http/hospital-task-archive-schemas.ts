import { z } from "zod";
import { hospitalTaskAssignmentSchema, hospitalTaskCommandSchema, hospitalTaskPrioritySchema } from "./hospital-task-schemas";
export const hospitalTaskArchiveSchema = z.object({ archived: z.boolean(), expectedVersion: z.number().int().positive() }).strict();
const taskId = z.string().min(1).max(100);
export const hospitalTaskBatchOperationSchema = z.discriminatedUnion("action", [hospitalTaskArchiveSchema.extend({ taskId, action: z.literal("ARCHIVE") }), hospitalTaskAssignmentSchema.extend({ taskId, action: z.literal("ASSIGN") }), hospitalTaskPrioritySchema.extend({ taskId, action: z.literal("PRIORITY") }), hospitalTaskCommandSchema.extend({ taskId, action: z.literal("COMMAND") })]);
export const hospitalTaskBatchSchema = z.object({ operations: z.array(hospitalTaskBatchOperationSchema).min(1).max(50).refine((entries) => new Set(entries.map((entry) => entry.taskId)).size === entries.length) }).strict();
