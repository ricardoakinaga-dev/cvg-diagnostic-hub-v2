import { z } from "zod";
import { hospitalTaskCreateSchema } from "./hospital-task-schemas";
export const hospitalTaskDraftCreateSchema = hospitalTaskCreateSchema;
export const hospitalTaskDraftCommandSchema = z.object({ command: z.enum(["PUBLISH", "DISCARD"]), expectedVersion: z.number().int().positive() }).strict();
