import type { HospitalDocument, HospitalDocumentFilters, HospitalDocumentOptions, HospitalDocumentPage, HospitalDocumentSummary, HospitalDocumentView } from "@cvg/contracts";
import { createHash } from "node:crypto";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalDocumentFiltersSchema } from "../http/hospital-document-schemas";
import { requireActiveUser, requirePermission } from "./service-common";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { canAccessHospitalDocument, existingHospitalDocument, hospitalDocumentView } from "./hospital-document-policy";
import { decodeKeysetCursor } from "./service-pagination";
import { createHospitalDocumentDraftService } from "./hospital-document-draft-service";
import { createHospitalDocumentPublicationService } from "./hospital-document-publication-service";

function documentSummary(document: HospitalDocument, favorite: boolean): HospitalDocumentSummary {
  const revision = document.revisions.find((entry) => entry.id === document.currentPublishedRevisionId && entry.status !== "DRAFT");
  return { id: document.id, code: document.code, title: document.title, departmentCode: document.departmentCode, responsibleUserId: document.responsibleUserId, locked: document.locked, archived: document.archived, ...(revision ? { currentRevision: revision.revision, currentStatus: revision.status as "APPROVED" | "RETIRED" } : {}), hasDraft: Boolean(document.draftRevisionId), favorite, version: document.version, updatedAt: document.updatedAt };
}
export function createHospitalDocumentService(context: Pick<ApplicationServiceContext, "store">) {
  return {
    ...createHospitalDocumentDraftService(context),
    ...createHospitalDocumentPublicationService(context),
    async getHospitalDocumentOptions(actor: User): Promise<HospitalDocumentOptions> {
      const state = await context.store.readState(); const current = requireActiveUser(state, actor);
      const allowed = (departmentCode: string) => canAccessHospitalDocument(current, "hospital_document.create", departmentCode) || canAccessHospitalDocument(current, "hospital_document.update", departmentCode);
      const departments = state.departments.filter((entry) => entry.active && allowed(entry.code));
      if (!departments.length && !allowed(current.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não pode preparar documentos operacionais.", 404);
      const responsibles = state.users.flatMap((user) => {
        if (!user.active || user.mustChangePassword) return [];
        const candidate = hydrateUserPermissions(state, user);
        return departments.some((department) => canAccessHospitalDocument(candidate, "hospital_document.view", department.code)) ? [{ id: user.id, displayName: user.displayName, departmentCode: user.departmentCode }] : [];
      });
      return { departments: departments.map(({ code, name }) => ({ code, name })), responsibles };
    },
    async listHospitalDocuments(actor: User, filters: HospitalDocumentFilters = {}): Promise<HospitalDocumentPage> {
      const parsed = hospitalDocumentFiltersSchema.safeParse(filters);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Revise os filtros e a página de documentos.", 400);
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_document.view", {});
      const departmentCode = filters.departmentCode?.toUpperCase(); const query = filters.query?.normalize("NFKC").trim().toLocaleLowerCase("pt-BR") ?? ""; const limit = filters.limit ?? 50;
      if (departmentCode && !canAccessHospitalDocument(current, "hospital_document.view", departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este setor de documentos.", 404);
      const scope = createHash("sha256").update(JSON.stringify([current.id, departmentCode ?? null, query, !!filters.includeArchived, !!filters.favoritesOnly])).digest("hex");
      const cursor = decodeKeysetCursor<{ scope: string; code: string; id: string }>(filters.cursor, (value) => value.scope === scope && typeof value.code === "string" && /^[A-Z0-9_-]{1,60}$/.test(value.code) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100);
      const favorites = new Set(state.workActivityPreferences.filter((entry) => entry.userId === current.id && entry.targetType === "HOSPITAL_DOCUMENT" && entry.favorite).map((entry) => entry.targetId));
      const rows = state.hospitalDocuments.filter((entry) => canAccessHospitalDocument(current, "hospital_document.view", entry.departmentCode) && (!departmentCode || entry.departmentCode === departmentCode) && (filters.includeArchived || !entry.archived) && (!filters.favoritesOnly || favorites.has(entry.id)) && (!query || `${entry.code} ${entry.title}`.normalize("NFKC").toLocaleLowerCase("pt-BR").includes(query))).sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
      const page = rows.filter((entry) => !cursor || entry.code.localeCompare(cursor.code) > 0 || entry.code === cursor.code && entry.id.localeCompare(cursor.id) > 0).slice(0, limit + 1); const selected = page.slice(0, limit); const last = selected.at(-1);
      return { items: selected.map((entry) => documentSummary(entry, favorites.has(entry.id))), total: rows.length, limit, ...(last && page.length > limit ? { nextCursor: Buffer.from(JSON.stringify({ scope, code: last.code, id: last.id })).toString("base64url") } : {}) };
    },
    async getHospitalDocument(actor: User, documentId: string): Promise<HospitalDocumentView> {
      const state = await context.store.readState(); const current = requireActiveUser(state, actor);
      return hospitalDocumentView(state, current, existingHospitalDocument(state, current, documentId, "hospital_document.view"));
    },
    async getHospitalDocumentHistory(actor: User, documentId: string) {
      const state = await context.store.readState(); const current = requireActiveUser(state, actor);
      return structuredClone(existingHospitalDocument(state, current, documentId, "hospital_document.view").revisions);
    }
  };
}
