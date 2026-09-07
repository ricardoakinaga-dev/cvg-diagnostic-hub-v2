import type { RoleCode } from "@cvg/contracts";
import type { Admission, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { managerCanAccessDepartment } from "../security/authorization";
import type { ApplicationServiceContext } from "./service-context";
import type { AdmissionContextCommandInput, AdmissionContextCommandResult } from "./service-types";
import {
  createAudit,
  createOutbox,
  ensureExpectedVersion,
  findOrThrow,
  id,
  requireActiveUser,
  requireIdempotencyKey,
  requirePermission,
  requireText,
  saveIdempotency,
  withIdempotency
} from "./service-common";

const TERMINAL_ITEM_STATES = new Set(["COMPLETED", "CANCELLED", "REJECTED"]);
const RESPONSIBLE_ROLES = new Set<RoleCode>(["VETERINARIAN", "INPATIENT_TEAM"]);

type AdmissionContextPolicy = {
  version: string;
  approvalReference: string;
  approvedAt: string;
  allowedResponsibleRoles: ReadonlySet<RoleCode>;
};

function requireAdmissionContextPolicy(): AdmissionContextPolicy {
  const version = process.env.ADMISSION_CONTEXT_POLICY_VERSION?.trim();
  const approvalReference = process.env.ADMISSION_CONTEXT_POLICY_APPROVAL_REF?.trim();
  const approvedAt = process.env.ADMISSION_CONTEXT_POLICY_APPROVED_AT?.trim();
  const configuredRoles = process.env.ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES?.split(",")
    .map((role) => role.trim().toUpperCase())
    .filter(Boolean) ?? [];
  const approvedAtMs = approvedAt ? Date.parse(approvedAt) : Number.NaN;
  const rolesAreValid = configuredRoles.length > 0
    && configuredRoles.every((role): role is RoleCode => RESPONSIBLE_ROLES.has(role as RoleCode));

  if (
    process.env.ADMISSION_CONTEXT_POLICY_ENABLED !== "true"
    || !version
    || Array.from(version).length > 100
    || !approvalReference
    || Array.from(approvalReference).length > 200
    || !approvedAt
    || Number.isNaN(approvedAtMs)
    || approvedAtMs > Date.now()
    || !rolesAreValid
  ) {
    throw new ApiError(
      "ADMISSION_CONTEXT_POLICY_UNAVAILABLE",
      "A política hospitalar de transferência, alta e responsabilidade ainda não está disponível.",
      503,
      { nextAction: "Aprovar e configurar a decisão D-01 antes de executar este comando." }
    );
  }

  return {
    version,
    approvalReference,
    approvedAt: new Date(approvedAtMs).toISOString(),
    allowedResponsibleRoles: new Set(configuredRoles as RoleCode[])
  };
}

function normalizedDepartmentCode(value: string): string {
  const code = requireText(value, "departmentCode", 60).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) {
    throw new ApiError("VALIDATION_ERROR", "O setor de destino é inválido.", 400);
  }
  return code;
}

function effectiveTimestamp(admission: Admission, value: string): string {
  if (Array.from(value).length > 100 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "A vigência deve usar data e hora RFC 3339 com fuso.", 400);
  }
  const parsed = Date.parse(value);
  const previous = Date.parse(admission.contextEffectiveAt ?? admission.admittedAt);
  if (Number.isNaN(parsed) || parsed <= previous || parsed > Date.now() + 30_000) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "A vigência deve ser posterior ao contexto atual e não pode estar no futuro.",
      400
    );
  }
  return new Date(parsed).toISOString();
}

function responsibleUser(
  state: StoreState,
  userId: string,
  patientId: string,
  departmentCode: string,
  policy: AdmissionContextPolicy
): User {
  const user = state.users.find((entry) => entry.id === userId);
  if (
    !user
    || user.active !== true
    || !policy.allowedResponsibleRoles.has(user.role)
    || user.departmentCode.trim().toUpperCase() !== departmentCode
    || !user.patientIds?.includes(patientId)
  ) {
    throw new ApiError(
      "ADMISSION_RESPONSIBLE_NOT_ELIGIBLE",
      "O responsável informado não está elegível no contexto aprovado.",
      422
    );
  }
  return user;
}

function contextLabel(admission: Admission): string {
  return admission.dischargedAt
    ? "DISCHARGED"
    : `${admission.departmentCode}/${admission.ward}/${admission.bed}/${admission.responsibleUserId ?? "UNASSIGNED"}`;
}

export function createAdmissionContextService({ store }: ApplicationServiceContext) {
  return {
    async updateAdmissionContext(
      actor: User,
      admissionId: string,
      input: AdmissionContextCommandInput
    ): Promise<AdmissionContextCommandResult> {
      const scope = `POST:/admissions/${admissionId}/context`;
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const admission = findOrThrow(originalState.admissions.find((entry) => entry.id === admissionId));
        const encounter = findOrThrow(originalState.encounters.find((entry) => entry.id === admission.encounterId));
        requirePermission(currentActor, "admission.context.manage", {
          patientId: encounter.patientId,
          departmentCode: admission.departmentCode
        });
        const policy = requireAdmissionContextPolicy();
        const idempotent = withIdempotency<AdmissionContextCommandResult>(
          originalState,
          currentActor.id,
          scope,
          input.idempotencyKey,
          { admissionId, input }
        );
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(admission.version, input.expectedVersion);
        if (admission.dischargedAt || encounter.status !== "OPEN") {
          throw new ApiError("INVALID_STATE_TRANSITION", "A internação já está encerrada.", 409);
        }

        const effectiveAt = effectiveTimestamp(admission, input.effectiveAt);
        const reason = requireText(input.reason, "reason", 500);
        const updatedAt = new Date().toISOString();
        let nextAdmission: Admission;
        let nextEncounter = encounter;
        let eventType: string;
        const metadata: Record<string, string | number | boolean | null> = {
          effectiveAt,
          reason,
          policyVersion: policy.version,
          policyApprovalRef: policy.approvalReference,
          policyApprovedAt: policy.approvedAt
        };

        if (input.action === "TRANSFER") {
          const departmentCode = normalizedDepartmentCode(input.departmentCode);
          if (!managerCanAccessDepartment(currentActor, departmentCode)) {
            throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
          }
          const ward = requireText(input.ward, "ward", 100);
          const bed = requireText(input.bed, "bed", 100);
          const responsible = responsibleUser(originalState, input.responsibleUserId, encounter.patientId, departmentCode, policy);
          if (departmentCode === admission.departmentCode && ward === admission.ward && bed === admission.bed && responsible.id === admission.responsibleUserId) {
            throw new ApiError("CONFLICT", "A transferência não altera o contexto atual.", 409);
          }
          nextAdmission = {
            ...admission,
            departmentCode,
            ward,
            bed,
            responsibleUserId: responsible.id,
            contextEffectiveAt: effectiveAt,
            updatedAt,
            version: admission.version + 1
          };
          eventType = "AdmissionTransferred";
          Object.assign(metadata, {
            previousDepartmentCode: admission.departmentCode,
            departmentCode,
            previousResponsibleUserId: admission.responsibleUserId ?? null,
            responsibleUserId: responsible.id
          });
        } else if (input.action === "BED_CHANGE") {
          const ward = requireText(input.ward, "ward", 100);
          const bed = requireText(input.bed, "bed", 100);
          if (ward === admission.ward && bed === admission.bed) {
            throw new ApiError("CONFLICT", "A mudança não altera a acomodação atual.", 409);
          }
          nextAdmission = {
            ...admission,
            ward,
            bed,
            contextEffectiveAt: effectiveAt,
            updatedAt,
            version: admission.version + 1
          };
          eventType = "AdmissionBedChanged";
          Object.assign(metadata, { previousWard: admission.ward, previousBed: admission.bed, ward, bed });
        } else if (input.action === "RESPONSIBILITY_CHANGE") {
          const responsible = responsibleUser(originalState, input.responsibleUserId, encounter.patientId, admission.departmentCode, policy);
          if (responsible.id === admission.responsibleUserId) {
            throw new ApiError("CONFLICT", "O responsável informado já está vigente.", 409);
          }
          nextAdmission = {
            ...admission,
            responsibleUserId: responsible.id,
            contextEffectiveAt: effectiveAt,
            updatedAt,
            version: admission.version + 1
          };
          eventType = "AdmissionResponsibilityChanged";
          Object.assign(metadata, {
            previousResponsibleUserId: admission.responsibleUserId ?? null,
            responsibleUserId: responsible.id,
            departmentCode: admission.departmentCode
          });
        } else {
          nextAdmission = {
            ...admission,
            dischargedAt: effectiveAt,
            contextEffectiveAt: effectiveAt,
            updatedAt,
            version: admission.version + 1
          };
          nextEncounter = { ...encounter, status: "CLOSED", closedAt: effectiveAt };
          eventType = "AdmissionDischarged";
          Object.assign(metadata, { departmentCode: admission.departmentCode });
        }

        const affectedRequests = originalState.requests.filter((request) => request.admissionId === admission.id);
        const affectedItemIds = new Set(affectedRequests.flatMap((request) => request.itemIds));
        const openItemCount = originalState.items.filter((item) => affectedItemIds.has(item.id) && !TERMINAL_ITEM_STATES.has(item.status)).length;
        const correlationId = input.correlationId ?? id("corr");
        const result: AdmissionContextCommandResult = {
          admission: nextAdmission,
          encounter: nextEncounter,
          affectedRequestCount: affectedRequests.length,
          openItemCount,
          openItemsPreserved: true,
          policyVersion: policy.version
        };
        let nextState: StoreState = {
          ...originalState,
          admissions: originalState.admissions.map((entry) => entry.id === admission.id ? nextAdmission : entry),
          encounters: originalState.encounters.map((entry) => entry.id === encounter.id ? nextEncounter : entry),
          auditEvents: [...originalState.auditEvents, createAudit(
            eventType,
            currentActor.id,
            "Admission",
            admission.id,
            correlationId,
            contextLabel(admission),
            contextLabel(nextAdmission),
            metadata
          )],
          outbox: [...originalState.outbox, createOutbox(eventType, "Admission", admission.id, correlationId, {
            admissionId: admission.id,
            encounterId: encounter.id,
            patientId: encounter.patientId,
            effectiveAt,
            policyVersion: policy.version
          })]
        };
        nextState = saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { admissionId, input });
        return { state: nextState, result };
      });
    }
  };
}
