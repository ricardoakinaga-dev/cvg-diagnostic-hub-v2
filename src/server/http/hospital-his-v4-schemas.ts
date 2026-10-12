import { z } from "zod";
import { PRIORITIES } from "@cvg/contracts";

const providerId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const hubId = z.string().trim().min(1).max(100);
const link = z.object({ hisId: providerId, hubId }).strict();
export const hospitalHisV4MappingsSchema = z.object({
  version: z.literal(1),
  actions: z.array(z.object({ event: z.literal("encounter.created"), action: z.literal("CREATE_INTAKE"), departmentCode: z.string().regex(/^[A-Z0-9_-]{1,60}$/), title: z.string().trim().min(1).max(200), priority: z.enum(PRIORITIES), typeId: hubId.optional() }).strict()).min(1).max(1),
  patients: z.array(link).min(1).max(10_000),
  encounters: z.array(link).min(1).max(10_000)
}).strict().superRefine((value, context) => {
  for (const key of ["patients", "encounters"] as const) {
    if (new Set(value[key].map(entry => entry.hisId)).size !== value[key].length || new Set(value[key].map(entry => entry.hubId)).size !== value[key].length) context.addIssue({ code: "custom", path: [key], message: "Vínculos devem ser explícitos e unívocos." });
  }
});
// HIS shared envelope identifiers count Unicode codepoints, including non-ASCII correlation IDs.
const envelopeId = z.string().regex(/^(?!\s*$)[\s\S]{1,255}(?![\s\S])/u);
const envelopeTimestamp = z.iso.datetime({ offset: true }).max(64);
/** Known technical metadata emitted by the pinned runtime/EventBus; it grants no native authority. */
const eventMetadata = z.object({
  eventId: z.uuid(), eventType: z.literal("encounter.created"), schemaVersion: z.literal(1),
  occurredAt: envelopeTimestamp, accountId: envelopeId, sourceModule: z.literal("encounters"),
  actor: z.object({ type: z.enum(["user", "service", "system"]), id: envelopeId }).strict(),
  correlationId: envelopeId, causationId: envelopeId.nullable(),
  publishedAt: envelopeTimestamp.optional(), sourceService: z.literal("cvg-his-v2-api").optional(),
  tenantId: envelopeId.optional(), traceparent: z.string().regex(/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/).optional()
}).strict();
/** Exact business fields and bounded optional metadata emitted by the inspected HIS source. */
export const hospitalHisV4WebhookSchema = z.object({
  id: providerId,
  event: z.literal("encounter.created"),
  timestamp: z.iso.datetime({ offset: true }),
  accountId: providerId,
  data: z.object({ id: providerId, accountId: providerId, patientId: providerId, ownerId: providerId, status: z.literal("reception"), visitType: z.enum(["walk_in", "scheduled", "return"]), origin: z.enum(["reception", "schedule", "return"]), reason: z.string().min(1).max(100_000), openedAt: z.iso.datetime({ offset: true }), createdByUserId: providerId, _meta: eventMetadata.optional() }).strict()
}).strict().refine(value => value.accountId === value.data.accountId && (!value.data._meta || value.data._meta.accountId === value.accountId), "Conta divergente no evento.");
const strings = z.array(z.string().min(1).max(300)).max(100);
const advertised = z.object({ provider: z.string().min(1).max(160).optional(), endpoints: strings, capabilities: strings.optional() });
/** Unknown additions are stripped; only this bounded nonclinical advertisement is exposed. */
export const hospitalHisV4RemoteCatalogSchema = z.object({
  accountId: providerId, apiKeyId: providerId, permissions: strings,
  eventBus: advertised, webhooks: z.object({ endpoints: strings, delivery: z.string().min(1).max(160) }),
  payments: advertised, email: advertised, sms: advertised, googleCalendar: advertised, laboratoryEquipmentBridge: advertised
});
export type HospitalHisV4Mappings = z.infer<typeof hospitalHisV4MappingsSchema>;
export type HospitalHisV4Webhook = z.infer<typeof hospitalHisV4WebhookSchema>;
export interface HospitalHisV4Headers { signature: string; timestamp: string; signatureVersion: string; webhookId: string; deliveryId: string; event: string; idempotencyKey: string }
