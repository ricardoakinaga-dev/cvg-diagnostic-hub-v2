import { z } from "zod";
import { PRIORITIES } from "@cvg/contracts";

const expectedVersion = z.number().int().positive().max(999_999_999_999_999).optional();
const timestamp = z.iso.datetime({ offset: true });
export const itemAssignmentSchema = z.object({ userId: z.string().min(1).max(100).nullable(), expectedVersion }).strict();
export const itemPrioritySchema = z.object({ priority: z.enum(PRIORITIES), reason: z.string().trim().min(1).max(500), expectedVersion }).strict();
export const itemPlanningSchema = z.object({ plannedStartsAt: timestamp.nullable(), plannedEndsAt: timestamp.nullable(), expectedVersion }).strict().refine((input) => input.plannedStartsAt === null && input.plannedEndsAt === null || input.plannedStartsAt !== null && input.plannedEndsAt !== null && Date.parse(input.plannedStartsAt) < Date.parse(input.plannedEndsAt), "Informe início e fim em ordem cronológica ou remova ambos.");
