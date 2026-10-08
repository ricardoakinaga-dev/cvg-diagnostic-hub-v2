import { z } from "zod";

const expectedVersion = z.number().int().positive().max(999_999_999_999_999).optional();
const codePointLength = (value: string) => Array.from(value).length;
const boundedText = (max: number) => z.string().transform((value) => value.trim()).refine(
  (value) => codePointLength(value) >= 1 && codePointLength(value) <= max,
  `text must contain between 1 and ${max} Unicode characters after trimming`
);
const boundedDateTime = z.string().max(100).datetime({ offset: true });
const structuredContent = z.record(z.string().refine((value) => codePointLength(value) <= 100, "content key is too long"), z.unknown()).refine((value) => Object.keys(value).length <= 100, "content has too many fields");
const structuredLaboratoryObservation = z.object({
  analyteCode: boundedText(100),
  value: z.union([z.number().finite(), boundedText(2000)]),
  unitCode: boundedText(100)
}).strict();
const structuredLaboratoryContent = z.object({
  kind: z.literal("LABORATORY_STRUCTURED"),
  panelCode: boundedText(100),
  panelVersion: z.number().int().positive().max(999_999_999),
  observations: z.array(structuredLaboratoryObservation).max(100)
}).strict();
const legacyResultContent = structuredContent.refine(
  (value) => value.kind !== "LABORATORY_STRUCTURED",
  "LABORATORY_STRUCTURED content must use the typed laboratory schema"
);
const resultContent = z.union([structuredLaboratoryContent, legacyResultContent]);

const admissionContextBase = {
  effectiveAt: boundedDateTime,
  reason: boundedText(500),
  expectedVersion
};

export const admissionContextSchema = z.discriminatedUnion("action", [
  z.object({
    ...admissionContextBase,
    action: z.literal("TRANSFER"),
    departmentCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/),
    ward: boundedText(100),
    bed: boundedText(100),
    responsibleUserId: boundedText(100)
  }).strict(),
  z.object({
    ...admissionContextBase,
    action: z.literal("BED_CHANGE"),
    ward: boundedText(100),
    bed: boundedText(100)
  }).strict(),
  z.object({
    ...admissionContextBase,
    action: z.literal("DISCHARGE")
  }).strict(),
  z.object({
    ...admissionContextBase,
    action: z.literal("RESPONSIBILITY_CHANGE"),
    responsibleUserId: boundedText(100)
  }).strict()
]);

export const encounterOpenSchema = z.object({
  encounterType: z.enum(["INPATIENT", "EMERGENCY", "OUTPATIENT"]),
  ward: boundedText(100).optional(),
  bed: boundedText(100).optional(),
  reason: boundedText(500).optional()
}).strict();

export const encounterCloseSchema = z.object({ reason: boundedText(500).optional() }).strict();

export const emptyCommandSchema = z.object({ expectedVersion }).strict();

export const cancelSchema = z.object({
  reasonCode: boundedText(60),
  reason: boundedText(500).optional(),
  itemIds: z.array(boundedText(100)).max(20).optional(),
  expectedVersion
}).strict().superRefine((value, context) => {
  if (value.itemIds && new Set(value.itemIds).size !== value.itemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["itemIds"], message: "itemIds must be unique" });
  }
});

export const rejectSchema = z.object({
  reasonCode: boundedText(60),
  note: boundedText(2000).optional(),
  expectedVersion
}).strict();

export const sampleSchema = z.object({
  accessionCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/).optional(),
  sampleType: boundedText(100).optional(),
  expectedVersion
}).strict();

export const recollectionSchema = z.object({
  reasonCode: boundedText(60),
  note: boundedText(2000).optional(),
  expectedVersion
}).strict();

export const scheduleSchema = z.object({
  startsAt: boundedDateTime,
  endsAt: boundedDateTime,
  resource: boundedText(100),
  reason: boundedText(500).optional(),
  expectedVersion
}).strict().superRefine((value, context) => {
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  if (endsAt <= startsAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt must be after startsAt" });
  } else if (endsAt - startsAt > 24 * 60 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "schedule window cannot exceed 24 hours" });
  }
});

export const resultDraftSchema = z.object({
  narrative: boundedText(20_000),
  conclusion: boundedText(5_000).optional(),
  content: resultContent,
  expectedVersion
}).strict();

export const releaseResultSchema = z.object({ critical: z.boolean().optional(), expectedVersion }).strict();

export const amendResultSchema = z.object({
  reason: boundedText(500),
  narrative: boundedText(20_000),
  conclusion: boundedText(5_000).optional(),
  content: resultContent,
  critical: z.boolean().optional(),
  expectedVersion
}).strict();

export const voidResultSchema = z.object({ reason: boundedText(500), expectedVersion }).strict();

export const reviewResultSchema = z.object({ versionId: boundedText(100), expectedVersion }).strict();

export const attachmentUploadSchema = z.object({
  filename: boundedText(255),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
  checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
  expectedVersion
}).strict();

export const attachmentFinalizeSchema = z.object({ expectedVersion }).strict();
export const acknowledgeNotificationSchema = z.object({
  expectedVersion,
  reason: boundedText(500),
  confirm: z.literal(true)
}).strict();
