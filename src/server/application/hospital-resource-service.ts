import type { HospitalResource, HospitalResourceFilters, HospitalResourceOptions, HospitalResourcePage } from "@cvg/contracts";
import { createHash } from "node:crypto";
import type { ApplicationServiceContext } from "./service-context";
import type { User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { hospitalResourceCreateSchema, hospitalResourcePatchSchema, type HospitalResourceCreateInput, type HospitalResourcePatchInput } from "../http/hospital-resource-schemas";
import { commandBody, validateCommand } from "./hospital-service-policy";
import { createAudit, createOutbox, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalResource, requireHospitalResourceAccess, resourceWindows, validateResourceDefinition } from "./hospital-resource-policy";
import { decodeKeysetCursor, pageSize } from "./service-pagination";

export function createHospitalResourceService({ store }: ApplicationServiceContext) {
  return {
    async getHospitalResourceOptions(actor: User): Promise<HospitalResourceOptions> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      const allowed = (departmentCode: string) => canAccessHospitalResource(current, "hospital_resource.create", departmentCode) || canAccessHospitalResource(current, "hospital_resource.update", departmentCode);
      const departments = state.departments.filter((department) => department.active && allowed(department.code));
      if (!departments.length && !canAccessHospitalResource(current, "hospital_resource.create", current.departmentCode) && !canAccessHospitalResource(current, "hospital_resource.update", current.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
      const professionals = state.users.filter((user) => user.active && departments.some((department) => department.code === user.departmentCode && department.memberUserIds.includes(user.id))).map((user) => ({ id: user.id, displayName: user.displayName, departmentCode: user.departmentCode })).sort((a, b) => a.displayName.localeCompare(b.displayName));
      return { departments: departments.map((department) => ({ code: department.code, name: department.name })), professionals };
    },
    async listHospitalResources(actor: User, filters: HospitalResourceFilters = {}): Promise<HospitalResourcePage> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      requirePermission(current, "hospital_resource.view", { departmentCode: filters.departmentCode });
      if (filters.departmentCode) requireHospitalResourceAccess(current, "hospital_resource.view", filters.departmentCode);
      if (filters.departmentCode && !/^[A-Z0-9_-]{1,60}$/.test(filters.departmentCode) || filters.kind && !["PROFESSIONAL", "ROOM", "EQUIPMENT", "BED"].includes(filters.kind) || (filters.query?.length ?? 0) > 200) throw new ApiError("VALIDATION_ERROR", "Filtros de inventário inválidos.", 400);
      const limit = pageSize(filters.limit ?? 50); const query = filters.query?.normalize("NFKC").trim().toLocaleLowerCase("pt-BR") ?? "";
      const scope = createHash("sha256").update(JSON.stringify([current.id, filters.departmentCode ?? null, filters.kind ?? null, !!filters.includeInactive, query])).digest("hex");
      const cursor = decodeKeysetCursor<{ scope: string; code: string; id: string }>(filters.cursor, (value) => value.scope === scope && typeof value.code === "string" && typeof value.id === "string" && value.id.length <= 100);
      const all = state.hospitalResources.filter((resource) => (filters.includeInactive || resource.active) && (!filters.departmentCode || resource.departmentCode === filters.departmentCode) && (!filters.kind || resource.kind === filters.kind) && (!query || `${resource.code} ${resource.name}`.normalize("NFKC").toLocaleLowerCase("pt-BR").includes(query)) && canAccessHospitalResource(current, "hospital_resource.view", resource.departmentCode)).sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
      const page = all.filter((resource) => !cursor || resource.code.localeCompare(cursor.code) > 0 || resource.code === cursor.code && resource.id.localeCompare(cursor.id) > 0).slice(0, limit + 1);
      const items = page.slice(0, limit); const last = items.at(-1);
      return { items: structuredClone(items), total: all.length, ...(page.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope, code: last.code, id: last.id })).toString("base64url") } : {}) };
    },
    async getHospitalResource(actor: User, resourceId: string): Promise<HospitalResource> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); const resource = state.hospitalResources.find((entry) => entry.id === resourceId);
      if (!resource) throw new ApiError("NOT_FOUND", "O recurso não está disponível.", 404);
      requireHospitalResourceAccess(current, "hospital_resource.view", resource.departmentCode); return structuredClone(resource);
    },
    async createHospitalResource(actor: User, input: HospitalResourceCreateInput): Promise<HospitalResource> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const body = validateCommand(hospitalResourceCreateSchema, commandBody(input));
        const departmentCode = body.departmentCode.toUpperCase(); requireHospitalResourceAccess(current, "hospital_resource.create", departmentCode); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-resources"; const replay = withIdempotency<HospitalResource>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const code = body.code.toUpperCase(); if (state.hospitalResources.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "O código já existe no inventário.", 409);
        const timestamp = now(); const resource: HospitalResource = { ...body, code, departmentCode, availabilityWindows: resourceWindows(body.availabilityWindows), id: id("hospital-resource"), version: 1, createdAt: timestamp, updatedAt: timestamp };
        validateResourceDefinition(state, resource); const correlation = input.correlationId ?? id("corr");
        const next = { ...state, hospitalResources: [...state.hospitalResources, resource], auditEvents: [...state.auditEvents, createAudit("HospitalResourceCreated", current.id, "HospitalResource", resource.id, correlation, undefined, "1", { code: resource.code, kind: resource.kind, departmentCode, availability: resource.availability, active: resource.active, userId: resource.userId ?? null })], outbox: [...state.outbox, createOutbox("HospitalResourceCreated", "HospitalResource", resource.id, correlation, { resourceId: resource.id, version: resource.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, resource, { input }), result: resource };
      });
    },
    async updateHospitalResource(actor: User, resourceId: string, input: HospitalResourcePatchInput): Promise<HospitalResource> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const body = validateCommand(hospitalResourcePatchSchema, commandBody(input)); const previous = state.hospitalResources.find((entry) => entry.id === resourceId);
        if (!previous) throw new ApiError("NOT_FOUND", "O recurso não está disponível.", 404);
        const onlyActivation = Object.keys(body).every((key) => key === "expectedVersion" || key === "active");
        const permission = onlyActivation ? "hospital_resource.deactivate" : "hospital_resource.update";
        requireHospitalResourceAccess(current, permission, previous.departmentCode);
        if (body.active !== undefined && body.active !== previous.active) requireHospitalResourceAccess(current, "hospital_resource.deactivate", previous.departmentCode);
        const departmentCode = body.departmentCode?.toUpperCase() ?? previous.departmentCode; requireHospitalResourceAccess(current, permission, departmentCode); requireIdempotencyKey(input.idempotencyKey);
        const scope = `PATCH:/hospital-resources/${resourceId}`; const replay = withIdempotency<HospitalResource>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        ensureExpectedVersion(previous.version, body.expectedVersion);
        const { expectedVersion: _version, ...changes } = body; const resource: HospitalResource = { ...previous, ...changes, departmentCode, availabilityWindows: resourceWindows(body.availabilityWindows ?? previous.availabilityWindows), version: previous.version + 1, updatedAt: now() };
        validateResourceDefinition(state, resource, previous); const correlation = input.correlationId ?? id("corr");
        const next = { ...state, hospitalResources: state.hospitalResources.map((entry) => entry.id === resourceId ? resource : entry), auditEvents: [...state.auditEvents, createAudit("HospitalResourceUpdated", current.id, "HospitalResource", resource.id, correlation, String(previous.version), String(resource.version), { departmentCode, previousDepartmentCode: previous.departmentCode, availability: resource.availability, previousAvailability: previous.availability, active: resource.active, previousActive: previous.active, name: resource.name, previousName: previous.name, availabilityWindows: JSON.stringify(resource.availabilityWindows), previousAvailabilityWindows: JSON.stringify(previous.availabilityWindows), ward: resource.ward ?? null, previousWard: previous.ward ?? null, bedLabel: resource.bedLabel ?? null, previousBedLabel: previous.bedLabel ?? null, allowedSpecies: resource.allowedSpecies?.join(",") ?? null, previousAllowedSpecies: previous.allowedSpecies?.join(",") ?? null })], outbox: [...state.outbox, createOutbox("HospitalResourceUpdated", "HospitalResource", resource.id, correlation, { resourceId: resource.id, version: resource.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, resource, { input }), result: resource };
      });
    }
  };
}
