import { z } from "zod";
import type { HospitalDocumentContent } from "@cvg/contracts";

const text = (max: number) => z.string().trim().min(1).max(max);
const code = z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/);
const version = z.number().int().positive();
const safeLink = z.string().max(2000).refine((value) => {
  try { const link = new URL(value); return link.protocol === "https:" && !link.username && !link.password; } catch { return false; }
}, "Links devem usar HTTPS e não conter credenciais.");
const inline = z.object({ text: z.string().max(20_000), marks: z.array(z.enum(["strong", "emphasis"])).max(2).refine((values) => new Set(values).size === values.length).optional(), href: safeLink.optional() }).strict();
const inlines = z.array(inline).max(200);
const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), content: inlines }).strict(),
  z.object({ type: z.literal("quote"), content: inlines }).strict(),
  z.object({ type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), content: inlines }).strict(),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(inlines).min(1).max(200) }).strict(),
  z.object({ type: z.literal("table"), rows: z.array(z.array(inlines).min(1).max(30)).min(1).max(200).refine((rows) => rows.every((row) => row.length === rows[0].length), "Todas as linhas da tabela devem ter o mesmo número de células."), header: z.boolean() }).strict(),
  z.object({ type: z.literal("code"), text: z.string().max(20_000) }).strict()
]);
export const hospitalDocumentContentSchema: z.ZodType<HospitalDocumentContent, HospitalDocumentContent> = z.object({ type: z.literal("hospital-document"), version: z.literal(1), blocks: z.array(block).max(500) }).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 200_000, "O documento excede o limite de conteúdo.");
export const hospitalDocumentCreateSchema = z.object({ code, title: text(200), departmentCode: code, responsibleUserId: text(100), content: hospitalDocumentContentSchema }).strict();
export const hospitalDocumentMetadataSchema = z.object({ responsibleUserId: text(100), expectedVersion: version }).strict();
export const hospitalDocumentDraftSchema = z.object({ title: text(200).optional(), content: hospitalDocumentContentSchema.optional(), expectedVersion: version, expectedDraftVersion: version }).strict().refine((value) => value.title !== undefined || value.content !== undefined, "Informe uma alteração no rascunho.");
export const hospitalDocumentRevisionSchema = z.object({ title: text(200).optional(), content: hospitalDocumentContentSchema.optional(), expectedVersion: version }).strict();
export const hospitalDocumentApproveSchema = z.object({ confirm: z.literal(true), policyReference: text(500), expectedVersion: version, expectedDraftVersion: version }).strict();
export const hospitalDocumentRetireSchema = z.object({ reason: text(1000), expectedRevisionId: text(100), expectedVersion: version }).strict();
export const hospitalDocumentLockSchema = z.object({ locked: z.boolean(), reason: text(1000), expectedVersion: version }).strict();
export const hospitalDocumentArchiveSchema = z.object({ archived: z.boolean(), reason: text(1000), expectedVersion: version }).strict();
export const hospitalDocumentDuplicateSchema = z.object({ code, title: text(200), responsibleUserId: text(100), sourceRevisionId: text(100).optional(), expectedVersion: version }).strict();
export const hospitalDocumentFavoriteSchema = z.object({ favorite: z.boolean() }).strict();
export const hospitalDocumentFiltersSchema = z.object({ departmentCode: code.optional(), query: z.string().max(200).optional(), includeArchived: z.boolean().optional(), favoritesOnly: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() }).strict();
type Metadata = { idempotencyKey?: string; correlationId?: string };
export type HospitalDocumentCreateInput = z.input<typeof hospitalDocumentCreateSchema> & Metadata;
export type HospitalDocumentMetadataInput = z.input<typeof hospitalDocumentMetadataSchema> & Metadata;
export type HospitalDocumentDraftInput = z.input<typeof hospitalDocumentDraftSchema> & Metadata;
export type HospitalDocumentRevisionInput = z.input<typeof hospitalDocumentRevisionSchema> & Metadata;
export type HospitalDocumentApproveInput = z.input<typeof hospitalDocumentApproveSchema> & Metadata;
export type HospitalDocumentRetireInput = z.input<typeof hospitalDocumentRetireSchema> & Metadata;
export type HospitalDocumentLockInput = z.input<typeof hospitalDocumentLockSchema> & Metadata;
export type HospitalDocumentArchiveInput = z.input<typeof hospitalDocumentArchiveSchema> & Metadata;
export type HospitalDocumentDuplicateInput = z.input<typeof hospitalDocumentDuplicateSchema> & Metadata;
export type HospitalDocumentFavoriteInput = z.input<typeof hospitalDocumentFavoriteSchema> & Metadata;
