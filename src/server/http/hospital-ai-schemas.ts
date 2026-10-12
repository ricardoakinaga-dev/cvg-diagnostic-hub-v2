import { z } from "zod";
import { hospitalDocumentContentSchema } from "./hospital-document-schemas";
const version = z.number().int().positive();
export const hospitalAiSuggestSchema = z.object({ confirmTransmission: z.literal(true), instruction: z.string().trim().min(1).max(1000), expectedVersion: version, expectedDraftVersion: version }).strict();
export const hospitalAiReviewSchema = z.object({ decision: z.enum(["APPLY", "REJECT"]), confirm: z.literal(true), reason: z.string().trim().min(1).max(1000), expectedVersion: version, expectedDocumentVersion: version, expectedDraftVersion: version }).strict();
export const hospitalAiRemoteResponseSchema = z.object({ contract: z.literal("CVG_DOCUMENT_ASSISTANCE_V1"), messageId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/), receiptId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/), model: z.string().trim().min(1).max(100), content: hospitalDocumentContentSchema }).strict();
type Metadata = { idempotencyKey?: string; correlationId?: string };
export type HospitalAiSuggestInput = z.input<typeof hospitalAiSuggestSchema> & Metadata;
export type HospitalAiReviewInput = z.input<typeof hospitalAiReviewSchema> & Metadata;
