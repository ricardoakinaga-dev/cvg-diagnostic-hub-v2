import { z } from "zod";
import { HOSPITAL_INTEGRATION_PURPOSES, HOSPITAL_INTEGRATION_SYSTEMS } from "@cvg/contracts";
import { hospitalIntakeCreateSchema } from "./hospital-task-schemas";
import { resultDraftSchema } from "./command-schemas";

const identifier = z.string().trim().min(1).max(100);
const externalId = z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const expectedVersion = z.number().int().positive();
const departmentCode = z.string().regex(/^[A-Z0-9_-]{1,60}$/);
const distinct = (schema: z.ZodString, max: number) => z.array(schema).min(1).max(max).refine((values) => new Set(values).size === values.length);
export const hospitalIntegrationCredentialCreateSchema = z.object({ profile: z.enum(["CVG_OPERATIONAL_V1", "HIS_V4"]).optional(), system: z.enum(HOSPITAL_INTEGRATION_SYSTEMS), purpose: z.enum(HOSPITAL_INTEGRATION_PURPOSES), actorUserId: identifier, name: z.string().trim().min(1).max(160), scope: z.object({ departmentCodes: distinct(departmentCode, 100), patientIds: distinct(identifier, 1000).optional() }).strict(), ttlSeconds: z.number().int().min(300).max(7_776_000) }).strict().refine((value) => value.purpose.startsWith(`${value.system}_`) && (value.profile !== "HIS_V4" || value.system === "HIS" && value.purpose === "HIS_INTAKE"), "Perfil ou finalidade incompatível com o sistema.");
export const hospitalIntegrationCredentialRotateSchema = z.object({ ttlSeconds: z.number().int().min(300).max(7_776_000), expectedVersion }).strict();
export const hospitalIntegrationCredentialRevokeSchema = z.object({ reason: z.string().trim().min(1).max(500), expectedVersion }).strict();
const message = { contract: z.literal("CVG_OPERATIONAL_V1"), messageId: externalId, externalEntityId: externalId, sequence: z.number().int().min(1).max(1_000_000_000), occurredAt: z.iso.datetime({ offset: true }) };
const integratedDraft = resultDraftSchema.extend({ expectedVersion });
const intake = hospitalIntakeCreateSchema.omit({ source: true, sourceRequestId: true, sourceLabel: true });
export const hospitalIntegrationMessageSchema = z.discriminatedUnion("purpose", [
  z.object({ ...message, purpose: z.literal("HIS_INTAKE"), payload: intake }).strict(),
  z.object({ ...message, purpose: z.literal("LIS_RESULT_DRAFT"), payload: z.object({ itemId: identifier, draft: integratedDraft }).strict() }).strict(),
  z.object({ ...message, purpose: z.literal("PACS_RESULT_DRAFT"), payload: z.object({ itemId: identifier, draft: integratedDraft }).strict() }).strict()
]);
export const hospitalIntegrationExchangeSchema = z.object({ system: z.enum(HOSPITAL_INTEGRATION_SYSTEMS), targetType: z.enum(["HOSPITAL_INTAKE", "DIAGNOSTIC_ITEM"]), targetId: identifier, messageId: externalId, externalEntityId: externalId, sequence: z.number().int().min(1).max(1_000_000_000), expectedVersion }).strict().refine((value) => value.system === "HIS" ? value.targetType === "HOSPITAL_INTAKE" : value.targetType === "DIAGNOSTIC_ITEM", "Tipo de origem incompatível com o sistema.");
export const hospitalIntegrationRetrySchema = z.object({ expectedVersion }).strict();
export const hospitalIntegrationFiltersSchema = z.object({ system: z.enum(HOSPITAL_INTEGRATION_SYSTEMS).optional(), direction: z.enum(["INBOUND", "OUTBOUND"]).optional(), status: z.enum(["CLAIMED", "SUCCEEDED", "FAILED"]).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() }).strict();
export const hospitalIntegrationRemoteReceiptSchema = z.object({ contract: z.literal("CVG_OPERATIONAL_V1"), messageId: externalId, receiptId: externalId, status: z.literal("ACCEPTED") }).strict();
type Metadata = { idempotencyKey?: string; correlationId?: string };
export type HospitalIntegrationCredentialCreateInput = z.input<typeof hospitalIntegrationCredentialCreateSchema> & Metadata;
export type HospitalIntegrationCredentialRotateInput = z.input<typeof hospitalIntegrationCredentialRotateSchema> & Metadata;
export type HospitalIntegrationCredentialRevokeInput = z.input<typeof hospitalIntegrationCredentialRevokeSchema> & Metadata;
export type HospitalIntegrationMessageInput = z.input<typeof hospitalIntegrationMessageSchema>;
export type HospitalIntegrationExchangeInput = z.input<typeof hospitalIntegrationExchangeSchema> & Metadata;
export type HospitalIntegrationRetryInput = z.input<typeof hospitalIntegrationRetrySchema> & Metadata;
export type HospitalIntegrationFilters = z.input<typeof hospitalIntegrationFiltersSchema>;
