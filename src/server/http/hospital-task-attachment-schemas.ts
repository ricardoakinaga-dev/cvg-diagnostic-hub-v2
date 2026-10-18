import { z } from "zod";
export const hospitalTaskAttachmentUploadSchema = z.object({ filename: z.string().min(1).max(255), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]), sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024), checksum: z.string().regex(/^[a-fA-F0-9]{64}$/), expectedVersion: z.number().int().positive() }).strict();
export const hospitalTaskAttachmentFinalizeSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const hospitalTaskAttachmentFiltersSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() }).strict();
