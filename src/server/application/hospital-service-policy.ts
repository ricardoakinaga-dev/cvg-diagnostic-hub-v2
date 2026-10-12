import type { HospitalService, Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource } from "../security/authorization";
import { requireActiveDepartment } from "./department-registry";
import { validateHospitalServiceBindings } from "./hospital-service-registry";
import { hospitalServiceCreateSchema, hospitalServicePatchSchema, type HospitalServiceCreateInput, type HospitalServicePatchInput } from "../http/hospital-service-schemas";

export function catalogPermission(actor: User, action: Permission, departmentCode?: string): void {
  if (!["service.catalog.manage" as const, action].some((permission) => canAccessResource(actor, permission, { departmentCode }))) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este serviço hospitalar.", 404);
}
export function commandBody<T extends { idempotencyKey?: string; correlationId?: string }>(input: T) { const { idempotencyKey: _key, correlationId: _correlation, ...body } = input; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); }
export function validateCommand<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError("VALIDATION_ERROR", "Revise os campos e vínculos do serviço hospitalar.", 400);
  return result.data!;
}
export function createHospitalServiceDefinition(state: StoreState, actor: User, input: HospitalServiceCreateInput, serviceId: string, timestamp: string): HospitalService {
  const body = validateCommand(hospitalServiceCreateSchema, commandBody(input));
  const code = body.code.toUpperCase(); const departmentCode = body.departmentCode.toUpperCase();
  catalogPermission(actor, "service.catalog.create", departmentCode);
  if (state.hospitalServices.some((entry) => entry.code === code) || state.services.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "Este código já existe no catálogo hospitalar ou diagnóstico.", 409);
  const service: HospitalService = { ...body, id: serviceId, code, departmentCode, version: 1, createdAt: timestamp, updatedAt: timestamp };
  validateHospitalServiceBindings(state, service);
  return service;
}
export function updateHospitalServiceDefinition(state: StoreState, actor: User, previous: HospitalService, input: HospitalServicePatchInput, timestamp: string): HospitalService {
  const body = validateCommand(hospitalServicePatchSchema, commandBody(input));
  const metadataChanged = Object.keys(body).some((key) => !["active", "expectedVersion"].includes(key));
  const action = body.active === false && !metadataChanged ? "service.catalog.deactivate" : "service.catalog.update";
  catalogPermission(actor, action, previous.departmentCode);
  const departmentCode = body.departmentCode?.toUpperCase() ?? previous.departmentCode;
  catalogPermission(actor, action, departmentCode);
  if (body.active === false && metadataChanged) catalogPermission(actor, "service.catalog.deactivate", previous.departmentCode);
  const { description: _oldDescription, ...withoutDescription } = previous;
  const { expectedVersion: _version, description, ...patch } = body;
  const next = { ...withoutDescription, ...patch, ...(description === undefined ? previous.description ? { description: previous.description } : {} : description === null ? {} : { description }), departmentCode, version: previous.version + 1, updatedAt: timestamp };
  const sameIds = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const bindingChanged = departmentCode !== previous.departmentCode || body.teamUserIds !== undefined && !sameIds(body.teamUserIds, previous.teamUserIds) || body.resourceIds !== undefined && !sameIds(body.resourceIds, previous.resourceIds);
  if (bindingChanged && !next.active) throw new ApiError("VALIDATION_ERROR", "Reative o serviço antes de criar vínculos de equipe, setor ou recursos.", 400);
  if (bindingChanged || !previous.active && next.active) validateHospitalServiceBindings(state, next);
  else if (previous.departmentCode !== departmentCode) requireActiveDepartment(state, departmentCode);
  return next;
}
