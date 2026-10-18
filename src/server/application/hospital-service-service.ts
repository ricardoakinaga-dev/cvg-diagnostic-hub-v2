import type { HospitalService, HospitalServiceCatalogEntry, HospitalServiceCatalogKind, HospitalServiceImportReport, Permission } from "@cvg/contracts";
import { createHash } from "node:crypto";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { canAccessResource } from "../security/authorization";
import { hospitalServiceCreateSchema, hospitalServicePatchSchema, hospitalServiceImportSchema, type HospitalServiceCreateInput, type HospitalServicePatchInput, type HospitalServiceImportInput } from "../http/hospital-service-schemas";
import { catalogPermission, commandBody, createHospitalServiceDefinition, updateHospitalServiceDefinition, validateCommand } from "./hospital-service-policy";
import { hospitalServiceCatalog } from "./hospital-service-registry";
import { authorizeHospitalServiceImportReplay, planHospitalServiceImport } from "./hospital-service-import";
import { createAudit, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { decodeKeysetCursor, pageSize } from "./service-pagination";

export interface HospitalServiceFilters { departmentCode?: string; kind?: HospitalServiceCatalogKind; includeInactive?: boolean; query?: string; limit?: number; cursor?: string }
const resource = (entry: HospitalServiceCatalogEntry) => ({ departmentCode: entry.departmentCode, ...(entry.source === "DIAGNOSTIC_SERVICE" ? { serviceCode: entry.code } : {}) });
const eventFor = (previous: HospitalService | undefined, next: HospitalService, actorId: string, correlationId: string) => createAudit(!previous ? "HospitalServiceCreated" : !next.active && previous.active ? "HospitalServiceDeactivated" : next.active && !previous.active ? "HospitalServiceReactivated" : "HospitalServiceUpdated", actorId, "HospitalService", next.id, correlationId, previous ? String(previous.version) : undefined, String(next.version), { code: next.code, name: next.name, description: next.description ?? null, departmentCode: next.departmentCode, kind: next.kind, teamUserIds: next.teamUserIds.join(","), resourceIds: next.resourceIds.join(","), ...(previous ? { previousDepartmentCode: previous.departmentCode, previousName: previous.name, previousDescription: previous.description ?? null, previousKind: previous.kind, previousTeamUserIds: previous.teamUserIds.join(","), previousResourceIds: previous.resourceIds.join(",") } : {}) });

export function createHospitalServiceService({ store }: ApplicationServiceContext) {
  return {
    async listHospitalServices(actor: User, filters: HospitalServiceFilters = {}) {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      requirePermission(current, "service.catalog.view", { departmentCode: filters.departmentCode });
      const limit = pageSize(filters.limit ?? 50);
      if (filters.kind && !["CARE", "PROCEDURE", "OPERATIONAL", "DIAGNOSTIC"].includes(filters.kind) || filters.query && filters.query.length > 200 || filters.departmentCode && !/^[A-Z0-9_-]{1,60}$/.test(filters.departmentCode)) throw new ApiError("VALIDATION_ERROR", "Filtros de serviços inválidos.", 400);
      const query = filters.query?.normalize("NFKC").trim().toLocaleLowerCase("pt-BR") ?? "";
      const scope = createHash("sha256").update(JSON.stringify([current.id, filters.departmentCode ?? null, filters.kind ?? null, !!filters.includeInactive, query])).digest("hex");
      const cursor = decodeKeysetCursor<{ scope: string; code: string; id: string }>(filters.cursor, (value) => value.scope === scope && typeof value.code === "string" && /^[A-Z0-9_-]{1,60}$/.test(value.code) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100);
      const all = hospitalServiceCatalog(state).filter((entry) => (filters.includeInactive || entry.active) && (!filters.departmentCode || entry.departmentCode === filters.departmentCode) && (!filters.kind || entry.kind === filters.kind) && (!query || `${entry.code} ${entry.name}`.normalize("NFKC").toLocaleLowerCase("pt-BR").includes(query)) && canAccessResource(current, "service.catalog.view", resource(entry))).sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
      const page = all.filter((entry) => !cursor || entry.code.localeCompare(cursor.code) > 0 || entry.code === cursor.code && entry.id.localeCompare(cursor.id) > 0).slice(0, limit + 1);
      const items = page.slice(0, limit); const last = items.at(-1);
      return { items: structuredClone(items), total: all.length, ...(page.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope, code: last.code, id: last.id })).toString("base64url") } : {}) };
    },
    async getHospitalService(actor: User, serviceId: string) {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      const service = hospitalServiceCatalog(state).find((entry) => entry.id === serviceId);
      if (!service) throw new ApiError("NOT_FOUND", "O serviço hospitalar não está disponível.", 404);
      requirePermission(current, "service.catalog.view", resource(service));
      return structuredClone(service);
    },
    async createHospitalService(actor: User, input: HospitalServiceCreateInput) {
      const scope = "POST:/hospital-services";
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const body = validateCommand(hospitalServiceCreateSchema, commandBody(input)); catalogPermission(current, "service.catalog.create", body.departmentCode.toUpperCase()); requireIdempotencyKey(input.idempotencyKey);
        const replay = withIdempotency<HospitalService>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const timestamp = now(); const next = createHospitalServiceDefinition(state, current, input, id("hospital-service"), timestamp);
        const changed = { ...state, hospitalServices: [...state.hospitalServices, next], auditEvents: [...state.auditEvents, eventFor(undefined, next, current.id, input.correlationId ?? id("corr"))] };
        return { state: saveIdempotency(changed, current.id, scope, input.idempotencyKey, next, { input }), result: next };
      });
    },
    async updateHospitalService(actor: User, serviceId: string, input: HospitalServicePatchInput) {
      const scope = "PATCH:/hospital-services";
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = state.hospitalServices.find((entry) => entry.id === serviceId);
        if (!previous) throw new ApiError("NOT_FOUND", "Edite a definição diagnóstica pela autoridade de exames ou escolha um serviço hospitalar existente.", 404);
        const body = validateCommand(hospitalServicePatchSchema, commandBody(input)); const metadata = Object.keys(body).some((key) => !["active", "expectedVersion"].includes(key));
        const action = input.active === false && !metadata ? "service.catalog.deactivate" : "service.catalog.update";
        catalogPermission(current, action, previous.departmentCode); catalogPermission(current, action, body.departmentCode?.toUpperCase() ?? previous.departmentCode);
        if (input.active === false && metadata) catalogPermission(current, "service.catalog.deactivate", previous.departmentCode);
        requireIdempotencyKey(input.idempotencyKey);
        const fingerprint = { serviceId, input }; const replay = withIdempotency<HospitalService>(state, current.id, scope, input.idempotencyKey, fingerprint);
        if (replay.found) return { state, result: replay.existing! };
        ensureExpectedVersion(previous.version, input.expectedVersion);
        const next = updateHospitalServiceDefinition(state, current, previous, input, now());
        const changed = { ...state, hospitalServices: state.hospitalServices.map((entry) => entry.id === serviceId ? next : entry), auditEvents: [...state.auditEvents, eventFor(previous, next, current.id, input.correlationId ?? id("corr"))] };
        return { state: saveIdempotency(changed, current.id, scope, input.idempotencyKey, next, fingerprint), result: next };
      });
    },
    async importHospitalServices(actor: User, input: HospitalServiceImportInput): Promise<HospitalServiceImportReport> {
      const scope = "POST:/hospital-services/import";
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        if (!( ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"] as Permission[]).some((permission) => canAccessResource(current, permission, {}))) throw new ApiError("SCOPE_DENIED", "Você não pode importar serviços hospitalares.", 404);
        const body = validateCommand(hospitalServiceImportSchema, commandBody(input));
        const dryRun = body.dryRun !== false;
        if (!dryRun) requireIdempotencyKey(input.idempotencyKey);
        const replay = !dryRun ? withIdempotency<HospitalServiceImportReport>(state, current.id, scope, input.idempotencyKey, { input }) : undefined;
        if (replay?.found) { authorizeHospitalServiceImportReplay(state, current, body.csv, replay.existing!); return { state, result: replay.existing! }; }
        const plan = planHospitalServiceImport(state, current, body.csv, now());
        if (dryRun) return { state, result: plan.report };
        if (plan.report.summary.error > 0) throw new ApiError("HOSPITAL_SERVICE_IMPORT_INVALID", "A importação contém vínculos ou revisões inválidas e não foi aplicada.", 422, { importReport: plan.report });
        const report = { ...plan.report, applied: true, dryRun: false };
        if (plan.changes.length === 0) return { state, result: report };
        const correlationId = input.correlationId ?? id("corr");
        const changed = { ...state, hospitalServices: [...state.hospitalServices.filter((entry) => !plan.changes.some((change) => change.next.id === entry.id)), ...plan.changes.map((change) => change.next)], auditEvents: [...state.auditEvents, ...plan.changes.map((change) => eventFor(change.previous, change.next, current.id, correlationId)), createAudit("HospitalServicesImported", current.id, "HospitalServiceCatalog", "hospital-services", correlationId, undefined, "APPLIED", { created: report.summary.create, updated: report.summary.update })] };
        return { state: saveIdempotency(changed, current.id, scope, input.idempotencyKey, report, { input }), result: report };
      });
    }
  };
}
