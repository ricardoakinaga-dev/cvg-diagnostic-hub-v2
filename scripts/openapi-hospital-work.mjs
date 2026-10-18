import { z } from "zod";
import * as work from "../src/server/http/work-activity-schemas.ts";
import * as comments from "../src/server/http/hospital-task-comment-schemas.ts";
import * as attachments from "../src/server/http/hospital-task-attachment-schemas.ts";
import * as institution from "../src/server/http/hospital-institution-schemas.ts";
import * as archive from "../src/server/http/hospital-task-archive-schemas.ts";
import * as drafts from "../src/server/http/hospital-task-draft-schemas.ts";
import * as tasks from "../src/server/http/hospital-task-schemas.ts";
import { hospitalTaskReactionSchema } from "../src/server/http/hospital-task-reaction-schemas.ts";
import { WORK_ACTIVITY_TARGETS, WORK_NOTIFICATION_EVENTS } from "../packages/contracts/src/work-activity.ts";
import { HOSPITAL_CAPABILITIES } from "../packages/contracts/src/hospital-institution.ts";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const text = (max = 200, min = 1) => ({ type: "string", minLength: min, maxLength: max });
const id = text(100), date = { type: "string", format: "date-time" }, revision = { type: "integer", minimum: 1 }, integer = { type: "integer", minimum: 0 }, bool = { type: "boolean" };
const array = (items) => ({ type: "array", items });
const enumeration = (...values) => ({ type: "string", enum: values });
const object = (properties, optional = []) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties).filter((key) => !optional.includes(key)) });
const page = (items) => object({ items: array(items), total: integer, limit: revision, nextCursor: text(2000) }, ["nextCursor"]);
function input(schema, versioned = false, constraints = []) {
  const result = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }); delete result.$schema;
  if (versioned && result.required) result.required = result.required.filter((key) => key !== "expectedVersion");
  if (constraints.length) result["x-cross-field-constraints"] = constraints; return result;
}
export const hospitalWorkRequestSchemas = {
  HospitalTaskReactionCommand: input(hospitalTaskReactionSchema, true),
  HospitalTaskCreate: input(tasks.hospitalTaskCreateSchema), HospitalTaskPatch: input(tasks.hospitalTaskPatchSchema, true),
  HospitalTaskArchive: input(archive.hospitalTaskArchiveSchema, true), HospitalTaskBatch: input(archive.hospitalTaskBatchSchema, false, ["task IDs must be distinct; every entry retains its own version and permission; durable batch binding is checked before applying independent commands"]),
  HospitalTaskDraftCreate: input(drafts.hospitalTaskDraftCreateSchema), HospitalTaskDraftCommand: input(drafts.hospitalTaskDraftCommandSchema, true),
  WorkActivityPreferenceCommand: input(work.workActivityPreferenceSchema, true, ["body expectedVersion=0 initializes an absent owned target preference; If-Match only permits positive versions", "current owner and target access required"]),
  WorkNotificationPreferenceCommand: input(work.workNotificationPreferenceSchema, true, ["body expectedVersion=0 initializes absent preferences; muted events must be distinct; critical alert policy is unchanged"]),
  WorkNotificationRead: input(work.workNotificationReadSchema, false, ["exactly one of notificationIds or all is required; unread requires explicit IDs"]), WorkNotificationArchive: input(work.workNotificationArchiveSchema, true),
  HospitalTaskCommentCreate: input(comments.hospitalTaskCommentCreateSchema, true), HospitalTaskCommentPatch: input(comments.hospitalTaskCommentPatchSchema, true), HospitalTaskCommentDelete: input(comments.hospitalTaskCommentDeleteSchema, true),
  HospitalTaskAttachmentUpload: input(attachments.hospitalTaskAttachmentUploadSchema, true), HospitalTaskAttachmentFinalize: input(attachments.hospitalTaskAttachmentFinalizeSchema, true), HospitalTaskAttachmentBinary: { type: "string", format: "binary", maxLength: 10 * 1024 * 1024 },
  HospitalInstitutionPut: input(institution.hospitalInstitutionPutSchema, true, ["body version zero is required for first configuration; timezone must be an IANA timezone"]), HospitalDepartmentCapability: input(institution.hospitalDepartmentCapabilitySchema, true),
  HospitalInvitationCreate: input(institution.hospitalInvitationCreateSchema), HospitalInvitationRevoke: input(institution.hospitalInvitationRevokeSchema, true), HospitalInvitationPreviewCommand: input(institution.hospitalInvitationPreviewSchema), HospitalInvitationAccept: input(institution.hospitalInvitationAcceptSchema)
};
const entity = { id, version: revision, createdAt: date, updatedAt: date };
const reaction = object({ userId: id, code: enumeration("LIKE", "THANKS", "QUESTION"), createdAt: date });
const target = object({ targetType: enumeration(...WORK_ACTIVITY_TARGETS), targetId: id, label: text(500), deepLink: text(500) });
const preference = object({ ...entity, userId: id, targetType: enumeration(...WORK_ACTIVITY_TARGETS), targetId: id, favorite: bool, following: bool, privateNote: text(4000, 0), lastOpenedAt: date, hiddenFromRecents: bool, favoriteGroup: text(80) }, ["privateNote", "lastOpenedAt", "favoriteGroup"]);
const notification = object({ id, sourceKey: text(500), userId: id, targetType: enumeration(...WORK_ACTIVITY_TARGETS), targetId: id, eventType: enumeration(...WORK_NOTIFICATION_EVENTS), readAt: date, archivedAt: date, version: revision, createdAt: date }, ["readAt", "archivedAt"]);
const notificationPreference = object({ ...entity, userId: id, mutedEvents: array(enumeration(...WORK_NOTIFICATION_EVENTS)) });
const attachment = object({ ...entity, taskId: id, safeName: text(255), declaredMime: enumeration("application/pdf", "image/jpeg", "image/png"), detectedMime: enumeration("application/pdf", "image/jpeg", "image/png"), sizeBytes: revision, checksum: text(64), scanStatus: enumeration("PENDING", "CLEAN", "QUARANTINED", "FAILED"), uploadStatus: enumeration("INITIATED", "UPLOADED", "FINALIZED"), expiresAt: date, createdBy: id }, ["detectedMime"]);
const settings = object({ id: enumeration("hospital-institution"), name: text(200), timezone: text(80), departmentCapabilities: array(object({ departmentCode: text(60), disabledNewWork: array(enumeration(...HOSPITAL_CAPABILITIES)), archived: bool })), version: revision, updatedAt: date, updatedBy: id });
const invitation = object({ ...entity, email: text(320), displayName: text(160), role: ref("RoleCode"), departmentCode: text(60), accessGroupId: id, expectedGroupVersion: revision, issuedBy: id, serviceCodes: array(text(60)), status: enumeration("PENDING", "ACCEPTED", "REVOKED"), expiresAt: date, acceptedBy: id, acceptedAt: date, revokedAt: date }, ["serviceCodes", "acceptedBy", "acceptedAt", "revokedAt"]);
export const hospitalWorkResponseSchemas = {
  HospitalTaskLabel: text(50), HospitalTaskReaction: reaction,
  HospitalTaskBatchResult: object({ items: array({ oneOf: [object({ taskId: id, ok: { const: true, type: "boolean" }, result: ref("HospitalTaskView") }), object({ taskId: id, ok: { const: false, type: "boolean" }, error: object({ code: text(100), status: { type: "integer", minimum: 400, maximum: 599 } }) })] }), successCount: integer, failureCount: integer }),
  WorkActivityTargetType: enumeration(...WORK_ACTIVITY_TARGETS), WorkActivityMode: enumeration("ALL", "FAVORITES", "RECENTS", "FOLLOWING", "NOTES"), WorkActivityPreference: preference,
  WorkActivityPreferenceView: object({ preference: ref("WorkActivityPreference"), target }), WorkActivityPreferencePage: page(ref("WorkActivityPreferenceView")),
  WorkNotification: notification, WorkNotificationView: object({ notification: ref("WorkNotification"), target, permissions: array(ref("Permission")) }), WorkNotificationPage: { ...page(ref("WorkNotificationView")), properties: { ...page(ref("WorkNotificationView")).properties, unread: integer }, required: ["items", "total", "unread", "limit"] },
  WorkNotificationPreference: notificationPreference, WorkNotificationPreferenceRead: { oneOf: [notificationPreference, object({ userId: id, mutedEvents: { type: "array", maxItems: 0, items: enumeration(...WORK_NOTIFICATION_EVENTS) }, version: { type: "integer", const: 0 } })] }, WorkNotificationsMarked: object({ marked: integer }),
  HospitalTaskComment: object({ ...entity, taskId: id, authorId: id, body: text(4000, 0), mentionedUserIds: array(id), revisions: array(object({ version: revision, body: text(4000, 0), mentionedUserIds: array(id), editedBy: id, editedAt: date })), deletedAt: date, deletedBy: id, deleteReason: text(500), reactions: array(reaction) }, ["deletedAt", "deletedBy", "deleteReason", "reactions"]),
  HospitalTaskCommentView: object({ comment: ref("HospitalTaskComment"), permissions: array(ref("Permission")), author: object({ id, displayName: text(160) }) }), HospitalTaskCommentPage: page(ref("HospitalTaskCommentView")),
  HospitalTaskPublicAttachment: attachment, HospitalTaskAttachmentPage: page(ref("HospitalTaskPublicAttachment")), HospitalTaskAttachmentSession: object({ attachment: ref("HospitalTaskPublicAttachment"), uploadUrl: text(500), expiresAt: date }), HospitalTaskAttachmentResult: object({ attachment: ref("HospitalTaskPublicAttachment") }),
  HospitalInstitutionSettings: settings, HospitalInstitutionView: object({ settings: { anyOf: [settings, { type: "null" }] }, permissions: array(ref("Permission")) }),
  HospitalInvitationOptions: object({ roles: array(ref("RoleCode")), departments: array(object({ code: text(60), name: text(120) })), groups: array(object({ id, code: text(60), description: text(160), version: revision })) }),
  HospitalUserInvitation: invitation, HospitalInvitationView: object({ invitation: ref("HospitalUserInvitation"), expired: bool }), HospitalInvitationViewList: array(ref("HospitalInvitationView")), HospitalInvitationIssued: object({ invitation: ref("HospitalUserInvitation"), token: text(43), tokenReturnedOnce: bool }, ["token"]),
  HospitalInvitationPreview: object({ institutionName: text(200), displayName: text(160), maskedEmail: text(320), expiresAt: date }), HospitalInvitationAccepted: object({ accepted: { type: "boolean", const: true }, userId: id, nextAction: enumeration("LOGIN") })
};
