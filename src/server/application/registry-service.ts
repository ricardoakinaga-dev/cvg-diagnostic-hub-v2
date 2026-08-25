import type { Admission, Encounter, Patient, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta, CreatePatientInput, PatientCreateResult } from "./service-types";
import { createAudit, createOutbox, findOrThrow, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";

function validBirthDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "A data de nascimento deve usar o formato AAAA-MM-DD.", 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError("VALIDATION_ERROR", "A data de nascimento informada é inválida.", 400);
  }
  if (parsed.getTime() > Date.now()) {
    throw new ApiError("VALIDATION_ERROR", "A data de nascimento não pode estar no futuro.", 400);
  }
  return value;
}

function normalizedExternalId(value: string | undefined, patientId: string): string {
  const candidate = value ? requireText(value, "externalId", 100).toUpperCase() : `CVG-${patientId.slice(-8).toUpperCase()}`;
  if (!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(candidate)) {
    throw new ApiError("VALIDATION_ERROR", "O identificador do paciente contém caracteres inválidos.", 400);
  }
  return candidate;
}

function normalizedEncounterExternalId(encounterId: string): string {
  return `ATD-${encounterId.slice(-8).toUpperCase()}`;
}

function createAdmission(encounter: Encounter, actor: User, ward: string, bed: string, openedAt: string): Admission {
  return {
    id: id("admission"),
    encounterId: encounter.id,
    departmentCode: actor.departmentCode,
    ward,
    bed,
    admittedAt: openedAt,
    version: 1
  };
}

export function createRegistryService({ store }: ApplicationServiceContext) {
  return {
    async createPatient(actor: User, input: CreatePatientInput, meta: CommandMeta = {}): Promise<PatientCreateResult> {
      const scope = "POST:/patients";
      return store.transaction(async (originalState: StoreState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requirePermission(currentActor, "patient.create", { departmentCode: currentActor.departmentCode });
        requireIdempotencyKey(meta.idempotencyKey);

        const idempotent = withIdempotency<PatientCreateResult>(originalState, currentActor.id, scope, meta.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };

        const displayName = requireText(input.displayName, "displayName", 120);
        const species = requireText(input.species, "species", 60);
        const breed = requireText(input.breed, "breed", 120);
        const sex = requireText(input.sex, "sex", 40);
        const ownerLabel = requireText(input.ownerLabel, "ownerLabel", 160);
        const birthDate = validBirthDate(input.birthDate);
        if (!["INPATIENT", "EMERGENCY", "OUTPATIENT"].includes(input.encounterType)) {
          throw new ApiError("VALIDATION_ERROR", "O tipo de atendimento informado é inválido.", 400);
        }

        const patientId = id("patient");
        const externalId = normalizedExternalId(input.externalId, patientId);
        if (originalState.patients.some((patient) => patient.externalId.toUpperCase() === externalId)) {
          throw new ApiError("CONFLICT", "Já existe um paciente com este identificador.", 409);
        }

        const openedAt = now();
        const patient: Patient = {
          id: patientId,
          displayName,
          species,
          breed,
          sex,
          ...(birthDate ? { birthDate } : {}),
          ownerLabel,
          externalId,
          active: true
        };
        const encounterId = id("encounter");
        const encounter: Encounter = {
          id: encounterId,
          patientId,
          externalId: normalizedEncounterExternalId(encounterId),
          type: input.encounterType,
          status: "OPEN",
          openedAt
        };

        const ward = input.ward ? requireText(input.ward, "ward", 100) : undefined;
        const bed = input.bed ? requireText(input.bed, "bed", 100) : undefined;
        if (input.encounterType === "INPATIENT" && (!ward || !bed)) {
          throw new ApiError("VALIDATION_ERROR", "Internação exige ala e leito.", 400);
        }
        if (input.encounterType !== "INPATIENT" && (ward || bed)) {
          throw new ApiError("VALIDATION_ERROR", "Ala e leito só podem ser informados para internação.", 400);
        }

        const admission = ward && bed ? createAdmission(encounter, currentActor, ward, bed, openedAt) : undefined;
        const persistedUser = findOrThrow(originalState.users.find((user) => user.id === currentActor.id));
        const patientIds = Array.from(new Set([...(persistedUser.patientIds ?? []), patient.id]));
        const updatedUser = { ...persistedUser, patientIds };
        const correlationId = meta.correlationId ?? id("corr");
        const audits = [
          createAudit("PatientCreated", currentActor.id, "Patient", patient.id, correlationId, undefined, "ACTIVE", { externalId: patient.externalId, encounterType: encounter.type }),
          createAudit("EncounterCreated", currentActor.id, "Encounter", encounter.id, correlationId, undefined, "OPEN", { patientId: patient.id, encounterType: encounter.type }),
          ...(admission ? [createAudit("AdmissionCreated", currentActor.id, "Admission", admission.id, correlationId, undefined, "OPEN", { encounterId: encounter.id, departmentCode: admission.departmentCode })] : [])
        ];
        const result: PatientCreateResult = { patient, encounter, ...(admission ? { admission } : {}) };
        const nextState: StoreState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === updatedUser.id ? updatedUser : user),
          patients: [...originalState.patients, patient],
          encounters: [...originalState.encounters, encounter],
          ...(admission ? { admissions: [...originalState.admissions, admission] } : {}),
          auditEvents: [...originalState.auditEvents, ...audits],
          outbox: [...originalState.outbox, createOutbox("PatientCreated", "Patient", patient.id, correlationId, { patientId: patient.id, encounterId: encounter.id, encounterType: encounter.type })]
        };
        return { state: saveIdempotency(nextState, currentActor.id, scope, meta.idempotencyKey, result, { input }), result };
      });
    }
  };
}
