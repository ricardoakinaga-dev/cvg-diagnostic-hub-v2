import type { SavedPlannerView, PlannerViewDisplay, PlannerViewFilters } from "@cvg/contracts";
import type { User, StoreState } from "../domain/models";
import type { CommandMeta } from "./service-types";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { canAccessHospitalTask, requireHospitalTaskAccess } from "./hospital-task-policy";
import { requireActiveDepartment } from "./department-registry";
import { requireHospitalPlanAccess } from "./hospital-plan-policy";
import { createAudit, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { plannerViewCreateSchema, plannerViewPatchSchema } from "../http/planner-view-schemas";
import { canAccessResource } from "../security/authorization";
import { canViewItem } from "./service-common";

type CreateViewInput = CommandMeta & { name: string; sharedDepartmentCode?: string; filters: PlannerViewFilters; display: PlannerViewDisplay };
type PatchViewInput = CommandMeta & { name?: string; sharedDepartmentCode?: string | null; filters?: PlannerViewFilters; display?: PlannerViewDisplay; active?: true };
function visible(state: StoreState, actor: User, view: SavedPlannerView) { return view.ownerId === actor.id || Boolean(view.sharedDepartmentCode && canAccessHospitalTask(state, actor, "planner_view.view", { departmentCode: view.sharedDepartmentCode })); }
function shared(state: StoreState, actor: User, code: string | undefined) {
  if (!code) return;
  requirePermission(actor, "planner_view.share", {});
  requireActiveDepartment(state, code);
  requireHospitalTaskAccess(state, actor, "planner_view.share", { departmentCode: code });
}
function validateRefs(state: StoreState, actor: User, filters: PlannerViewFilters) {
  const mayFilterDiagnostics = canAccessResource(actor, "planner_view.view", {});
  const diagnosticDepartment = (code: string) => mayFilterDiagnostics && state.items.some(item => item.departmentCode === code && canViewItem(state, actor, item));
  if (filters.departmentCode && !canAccessHospitalTask(state, actor, "planner_view.view", { departmentCode: filters.departmentCode }) && !diagnosticDepartment(filters.departmentCode)) throw new ApiError("SCOPE_DENIED", "O setor do filtro não está no seu escopo.", 404);
  if (filters.typeId && !state.hospitalTaskTypes.some((type) => type.id === filters.typeId)) throw new ApiError("VALIDATION_ERROR", "O tipo de tarefa do filtro não existe.", 400);
  if (filters.responsibleUserId) {
    const user = state.users.find((entry) => entry.id === filters.responsibleUserId);
    const assignedDiagnostic = mayFilterDiagnostics && state.items.some(item => item.assignedUserId === filters.responsibleUserId && canViewItem(state, actor, item));
    if (!user || !canAccessHospitalTask(state, actor, "planner_view.view", { departmentCode: user.departmentCode }) && !assignedDiagnostic) throw new ApiError("SCOPE_DENIED", "O responsável do filtro não está no seu escopo.", 404);
  }
  if (filters.planId) requireHospitalPlanAccess(state, actor, "plan.view", findOrThrowScoped(state.hospitalPlans.find((plan) => plan.id === filters.planId)));
}
function uniqueName(state: StoreState, view: Pick<SavedPlannerView, "id" | "ownerId" | "name" | "active">) {
  if (view.active && state.savedPlannerViews.some((entry) => entry.id !== view.id && entry.active && entry.ownerId === view.ownerId && entry.name.toLocaleLowerCase("pt-BR") === view.name.toLocaleLowerCase("pt-BR"))) throw new ApiError("CONFLICT", "Você já tem uma visão ativa com esse nome.", 409);
}
export function createPlannerViewService({ store }: ApplicationServiceContext) {
  return {
    async listPlannerViews(actor: User) {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      requirePermission(current, "planner_view.view", {});
      return state.savedPlannerViews.filter((view) => view.active && visible(state, current, view)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map((view) => structuredClone(view));
    },
    async createPlannerView(actor: User, input: CreateViewInput): Promise<SavedPlannerView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "planner_view.create", {}); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/planner-views"; const replay = withIdempotency<SavedPlannerView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const { idempotencyKey: _key, correlationId: _correlation, expectedVersion: _version, ...body } = input;
        const parsed = plannerViewCreateSchema.safeParse(body);
        if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os filtros ou a apresentação da visão são inválidos.", 400);
        shared(state, current, parsed.data.sharedDepartmentCode); validateRefs(state, current, parsed.data.filters);
        const timestamp = now(); const view: SavedPlannerView = { ...parsed.data, id: id("planner-view"), ownerId: current.id, active: true, version: 1, createdAt: timestamp, updatedAt: timestamp };
        uniqueName(state, view);
        const next = { ...state, savedPlannerViews: [...state.savedPlannerViews, view], auditEvents: [...state.auditEvents, createAudit("PlannerViewCreated", current.id, "SavedPlannerView", view.id, input.correlationId ?? id("corr"), undefined, "ACTIVE", { sharedDepartmentCode: view.sharedDepartmentCode ?? "", configurationOnly: true })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, view, { input }), result: view };
      });
    },
    async updatePlannerView(actor: User, viewId: string, input: PatchViewInput): Promise<SavedPlannerView> {
      return change(actor, viewId, input, false);
    },
    async deactivatePlannerView(actor: User, viewId: string, input: CommandMeta): Promise<SavedPlannerView> {
      return change(actor, viewId, input, true);
    }
  };
  function change(actor: User, viewId: string, input: PatchViewInput, deactivate: boolean) {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); requirePermission(current, deactivate ? "planner_view.deactivate" : "planner_view.update", {});
      const previous = findOrThrowScoped(state.savedPlannerViews.find((entry) => entry.id === viewId && entry.ownerId === current.id));
      requireIdempotencyKey(input.idempotencyKey);
      const scope = `${deactivate ? "POST" : "PATCH"}:/planner-views/${viewId}`;
      const replay = withIdempotency<SavedPlannerView>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: replay.existing! };
      ensureExpectedVersion(previous.version, input.expectedVersion);
      let view: SavedPlannerView;
      if (deactivate) view = { ...previous, active: false };
      else {
        const { idempotencyKey: _key, correlationId: _correlation, ...body } = input;
        const parsed = plannerViewPatchSchema.safeParse(body);
        if (!parsed.success || Object.keys(body).every((key) => key === "expectedVersion")) throw new ApiError("VALIDATION_ERROR", "Informe uma alteração válida na visão.", 400);
        if (parsed.data.sharedDepartmentCode !== null) shared(state, current, parsed.data.sharedDepartmentCode ?? previous.sharedDepartmentCode);
        const { expectedVersion: _expected, ...changes } = parsed.data;
        if (parsed.data.filters) validateRefs(state, current, parsed.data.filters);
        view = { ...previous, ...changes, sharedDepartmentCode: parsed.data.sharedDepartmentCode === null ? undefined : parsed.data.sharedDepartmentCode ?? previous.sharedDepartmentCode };
      }
      view = { ...view, version: previous.version + 1, updatedAt: now() }; uniqueName(state, view);
      const next = { ...state, savedPlannerViews: state.savedPlannerViews.map((entry) => entry.id === viewId ? view : entry), auditEvents: [...state.auditEvents, createAudit(deactivate ? "PlannerViewDeactivated" : "PlannerViewUpdated", current.id, "SavedPlannerView", viewId, input.correlationId ?? id("corr"), String(previous.version), String(view.version), { sharedDepartmentCode: view.sharedDepartmentCode ?? "", configurationOnly: true })] };
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, view, { input }), result: view };
    });
  }
}
