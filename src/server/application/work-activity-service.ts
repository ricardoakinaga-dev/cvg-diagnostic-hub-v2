import type { WorkActivityPreference, WorkActivityPreferenceView } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { WorkActivityPreferenceFilters, WorkActivityPreferenceInput } from "./work-activity-types";
import { ApiError } from "../http/envelope";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { pagePlannerObjects, validateTaskBody } from "./hospital-task-common";
import { resolveWorkActivity } from "./work-activity-policy";
import { workActivityPreferenceFiltersSchema, workActivityPreferenceSchema } from "../http/work-activity-schemas";

export function createWorkActivityService({ store }: ApplicationServiceContext) {
  return {
    async listWorkActivityPreferences(actor: User, filters: WorkActivityPreferenceFilters = {}) {
      validateTaskBody(workActivityPreferenceFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "work_activity.preference.manage", {});
      if (filters.targetId) resolveWorkActivity(state, current, filters.targetType!, filters.targetId);
      const rows = state.workActivityPreferences.filter((entry) => entry.userId === current.id && (!filters.targetType || entry.targetType === filters.targetType) && (!filters.targetId || entry.targetId === filters.targetId) && (!filters.mode || filters.mode === "ALL" || filters.mode === "FAVORITES" && entry.favorite || filters.mode === "FOLLOWING" && entry.following || filters.mode === "NOTES" && Boolean(entry.privateNote) || filters.mode === "RECENTS" && Boolean(entry.lastOpenedAt) && !entry.hiddenFromRecents)).flatMap((preference) => { try { return [{ preference, target: resolveWorkActivity(state, current, preference.targetType, preference.targetId) }]; } catch { return []; } });
      const page = pagePlannerObjects(rows.map((entry) => ({ ...entry, id: entry.preference.id, createdAt: filters.mode === "RECENTS" ? entry.preference.lastOpenedAt! : entry.preference.updatedAt })), filters); return { ...page, items: page.items.map(({ preference, target }) => ({ preference, target })) };
    },
    async putWorkActivityPreference(actor: User, input: WorkActivityPreferenceInput): Promise<WorkActivityPreferenceView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "work_activity.preference.manage", {}); validateTaskBody(workActivityPreferenceSchema, input); requireIdempotencyKey(input.idempotencyKey); const target = resolveWorkActivity(state, current, input.targetType, input.targetId);
        const previous = state.workActivityPreferences.find((entry) => entry.userId === current.id && entry.targetType === input.targetType && entry.targetId === input.targetId); const scope = "PUT:/work-activity-preferences"; const replay = withIdempotency<WorkActivityPreferenceView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: { preference: findOrThrowScoped(state.workActivityPreferences.find((entry) => entry.id === replay.existing!.preference.id && entry.userId === current.id)), target } };
        if (Object.keys(input).every((key) => ["targetType", "targetId", "expectedVersion", "idempotencyKey", "correlationId"].includes(key))) throw new ApiError("VALIDATION_ERROR", "Informe a preferência que deseja alterar.", 400);
        ensureExpectedVersion(previous?.version ?? 0, input.expectedVersion); const timestamp = now(); const preference: WorkActivityPreference = { id: previous?.id ?? id("work-preference"), userId: current.id, targetType: input.targetType, targetId: input.targetId, favorite: input.favorite ?? previous?.favorite ?? false, favoriteGroup: input.favoriteGroup === undefined ? previous?.favoriteGroup : input.favoriteGroup?.trim() || undefined, following: input.following ?? previous?.following ?? false, privateNote: input.privateNote === undefined ? previous?.privateNote : input.privateNote?.trim() || undefined, lastOpenedAt: input.opened ? timestamp : previous?.lastOpenedAt, hiddenFromRecents: input.hiddenFromRecents ?? (input.opened ? false : previous?.hiddenFromRecents ?? false), version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
        const next = { ...state, workActivityPreferences: previous ? state.workActivityPreferences.map((entry) => entry.id === preference.id ? preference : entry) : [...state.workActivityPreferences, preference], auditEvents: [...state.auditEvents, createAudit("WorkActivityPreferenceUpdated", current.id, "WorkActivityPreference", preference.id, input.correlationId ?? id("corr"), previous ? String(previous.version) : undefined, String(preference.version), { targetType: preference.targetType, hasPrivateNote: Boolean(preference.privateNote), favorite: preference.favorite, following: preference.following, privateMetadataOnly: true })], outbox: [...state.outbox, createOutbox("WorkActivityPreferenceUpdated", "WorkActivityPreference", preference.id, input.correlationId ?? id("corr"), { version: preference.version })] };
        const result = { preference, target }; return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
