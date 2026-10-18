import type { HospitalInstitutionSettings, HospitalInstitutionView } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import type { z } from "zod";
import { hospitalInstitutionPutSchema, hospitalDepartmentCapabilitySchema } from "../http/hospital-institution-schemas";
import { requireActiveUser, requirePermission, ensureExpectedVersion, requireIdempotencyKey, saveIdempotency, withIdempotency, validatedTimezone, createAudit, createOutbox, id, now } from "./service-common";
import { validateTaskBody } from "./hospital-task-common";
import { requireActiveDepartment, normalizedDepartmentCode } from "./department-registry";
import { canAccessResource } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hospitalTimezone } from "../../lib/hospital-time";

function institutionTimezone(value: string) {
  const timezone = validatedTimezone(value);
  const canonical = (zone: string) => new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  const runtimeTimezone = validatedTimezone(process.env.APP_TIMEZONE?.trim() || hospitalTimezone());
  if (canonical(timezone) !== canonical(runtimeTimezone) || canonical(timezone) !== canonical(hospitalTimezone())) {
    throw new ApiError("VALIDATION_ERROR", "O fuso deve corresponder a APP_TIMEZONE e NEXT_PUBLIC_HOSPITAL_TIMEZONE da instalação. Atualize a configuração da release antes de alterar o fuso institucional.", 400);
  }
  return timezone;
}
export function createHospitalInstitutionService({ store }: ApplicationServiceContext) {
  return {
    async getHospitalInstitutionSettings(actor: User): Promise<HospitalInstitutionView> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      return { settings: state.hospitalInstitutionSettings[0] ? structuredClone(state.hospitalInstitutionSettings[0]) : null, permissions: (["institution.manage", "department.capabilities.manage", "user_invite.manage"] as const).filter((permission) => canAccessResource(current, permission, {})) };
    },
    async putHospitalInstitutionSettings(actor: User, input: z.input<typeof hospitalInstitutionPutSchema> & CommandMeta): Promise<HospitalInstitutionSettings> {
      validateTaskBody(hospitalInstitutionPutSchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "institution.manage", {}); requireIdempotencyKey(input.idempotencyKey);
        const previous = state.hospitalInstitutionSettings[0]; const scope = "PUT:/hospital-institution";
        const replay = withIdempotency<HospitalInstitutionSettings>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: previous! };
        ensureExpectedVersion(previous?.version ?? 0, input.expectedVersion); const timestamp = now();
        const settings: HospitalInstitutionSettings = { id: "hospital-institution", name: input.name.trim(), timezone: institutionTimezone(input.timezone), departmentCapabilities: previous?.departmentCapabilities ?? [], version: (previous?.version ?? 0) + 1, updatedAt: timestamp, updatedBy: current.id };
        const correlation = input.correlationId ?? id("corr");
        const next = { ...state, hospitalInstitutionSettings: [settings], auditEvents: [...state.auditEvents, createAudit("HospitalInstitutionConfigured", current.id, "HospitalInstitution", settings.id, correlation, undefined, undefined, { version: settings.version })], outbox: [...state.outbox, createOutbox("HospitalInstitutionConfigured", "HospitalInstitution", settings.id, correlation, { version: settings.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, settings, { input }), result: settings };
      });
    },
    async putHospitalDepartmentCapabilities(actor: User, departmentCode: string, input: z.input<typeof hospitalDepartmentCapabilitySchema> & CommandMeta): Promise<HospitalInstitutionSettings> {
      validateTaskBody(hospitalDepartmentCapabilitySchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "department.capabilities.manage", {}); requireIdempotencyKey(input.idempotencyKey);
        const code = normalizedDepartmentCode(departmentCode); requireActiveDepartment(state, code); const previous = state.hospitalInstitutionSettings[0];
        if (!previous) throw new ApiError("INVALID_STATE_TRANSITION", "Configure a instituição antes dos módulos por setor.", 409);
        const scope = `PUT:/hospital-departments/${code}/capabilities`; const replay = withIdempotency<HospitalInstitutionSettings>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: previous };
        ensureExpectedVersion(previous.version, input.expectedVersion); const entry = { departmentCode: code, disabledNewWork: [...input.disabledNewWork], archived: input.archived }; const timestamp = now();
        const settings = { ...previous, departmentCapabilities: [...previous.departmentCapabilities.filter((entry) => entry.departmentCode !== code), entry].sort((a, b) => a.departmentCode.localeCompare(b.departmentCode)), version: previous.version + 1, updatedAt: timestamp, updatedBy: current.id };
        const correlation = input.correlationId ?? id("corr"); const next = { ...state, hospitalInstitutionSettings: [settings], auditEvents: [...state.auditEvents, createAudit("HospitalDepartmentCapabilitiesChanged", current.id, "Department", code, correlation, undefined, undefined, { departmentCode: code, archived: input.archived, disabledNewWork: input.disabledNewWork.join(","), version: settings.version })], outbox: [...state.outbox, createOutbox("HospitalDepartmentCapabilitiesChanged", "Department", code, correlation, { departmentCode: code, version: settings.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, settings, { input }), result: settings };
      });
    }
  };
}
