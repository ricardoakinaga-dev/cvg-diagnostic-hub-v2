import { z } from "zod";
export const hospitalTaskReactionSchema = z.object({ code: z.enum(["LIKE", "THANKS", "QUESTION"]), active: z.boolean(), expectedVersion: z.number().int().positive() }).strict();
