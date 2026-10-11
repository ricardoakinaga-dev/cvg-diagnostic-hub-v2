import type { ClinicalArchiveEntry, ClinicalArchiveRow, DiagnosticItem, DiagnosticRequest, Result, ResultVersion, Sample, Attachment, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource, hasPermission, managerCanAccessDepartment } from "../security/authorization";
import { findById } from "../domain/state-index";
import { archiveEntries, archivedEntitiesOf } from "../domain/clinical-archive";
import { createAudit, id, isExecutorRole, requireActiveUser, requirePatientPermission, requirePermission } from "./service-common";
import { pageSize } from "./service-pagination";
import type { ApplicationServiceContext } from "./service-context";
import type { ArchivedRequestView } from "./service-types";

const DENIED = () => new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
/** Requests read per round trip while scanning a patient's archive for the entries the actor may see. */
export const ARCHIVE_SCAN_PAGE = 100;
const PATIENT_ARCHIVE_PERMISSIONS = ["patient.view", "diagnostic.timeline.view"] as const;

/**
 * The archive follows the active reads item by item (AUD-05): `item.view` on the
 * item's department and service decides what every profile sees, exactly like
 * `canViewItem` does for the active aggregate. An entry (or an archived
 * request) is visible when at least one of its items is, or, for a manager,
 * when the requesting department is delegated to them (`canViewRequest`).
 */
function canViewArchivedItem(actor: User, patientId: string, item: { departmentCode: string; serviceCode: string }): boolean {
  return canAccessResource(actor, "item.view", { patientId, departmentCode: item.departmentCode, serviceCode: item.serviceCode });
}

/** The entry reduced to the services the actor may see, or undefined when the entry is out of scope. */
function scopedArchiveEntry(actor: User, entry: ClinicalArchiveEntry): ClinicalArchiveEntry | undefined {
  const services = entry.services.filter((service) => canViewArchivedItem(actor, entry.patientId, { departmentCode: service.departmentCode, serviceCode: service.code }));
  const visible = actor.role === "MANAGER"
    ? canAccessResource(actor, "request.view", {}) && (services.length > 0 || managerCanAccessDepartment(actor, entry.requestingDepartmentCode))
    : isExecutorRole(actor)
      ? services.length > 0
      : canAccessResource(actor, "request.view", { patientId: entry.patientId, departmentCode: entry.requestingDepartmentCode });
  if (!visible) return undefined;
  return { ...entry, services, attachmentCount: services.reduce((count, service) => count + service.attachmentCount, 0) };
}

function requirePatientArchiveAccess(state: StoreState, actor: User, patientId: string): unknown {
  if (!findById(state.patients, patientId)) throw DENIED();
  let refusal: unknown;
  for (const permission of PATIENT_ARCHIVE_PERMISSIONS) {
    try {
      requirePatientPermission(state, actor, permission, patientId);
    } catch (error) {
      const archiveOnly = (actor.role === "MANAGER" || isExecutorRole(actor)) && hasPermission(actor.role, permission);
      if (!archiveOnly) throw error;
      refusal ??= error;
    }
  }
  return refusal;
}

export function createArchiveService({ store }: ApplicationServiceContext) {
  return {
    async listPatientArchive(actor: User, patientId: string, filters: { limit?: number } = {}): Promise<ClinicalArchiveEntry[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const limit = pageSize(filters.limit);
      // The active permissions are checked before the archive is read: only a manager or an executor whose only
      // context for this patient is archived may fall back on the archive scope, so nobody else makes the server
      // read the archive just to be refused (audit of 09/10).
      requirePatientArchiveAccess(state, currentActor, patientId);
      // Scope first, then page (AUD-08): a newer record of another department must not hide an older visible one.
      // The archive is read a page of requests at a time and the scan stops once `limit` visible entries are found,
      // so a long history is never materialized whole for one page of answers.
      const visible: ClinicalArchiveEntry[] = [];
      for (let offset = 0; visible.length < limit; offset += ARCHIVE_SCAN_PAGE) {
        const page = await store.readClinicalArchive({ patientId, limit: ARCHIVE_SCAN_PAGE, offset });
        const pageState = await store.readState();
        const pageActor = requireActiveUser(pageState, currentActor);
        requirePatientArchiveAccess(pageState, pageActor, patientId);
        for (const entry of page) {
          const scoped = scopedArchiveEntry(pageActor, entry);
          if (scoped && visible.length < limit) visible.push(scoped);
        }
        if (page.length < ARCHIVE_SCAN_PAGE) break;
      }
      const finalState = await store.readState();
      const finalActor = requireActiveUser(finalState, currentActor);
      const refusal = requirePatientArchiveAccess(finalState, finalActor, patientId);
      const finalVisible = visible.flatMap((entry) => {
        const scoped = scopedArchiveEntry(finalActor, entry);
        return scoped ? [scoped] : [];
      });
      // The archive-only fallback needs something archived that this actor may see.
      if (refusal !== undefined && finalVisible.length === 0) throw refusal;
      return finalVisible;
    },

    async getArchivedRequest(actor: User, requestId: string, correlationId = id("corr")): Promise<ArchivedRequestView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const rows = await store.readArchivedRequest(requestId);
      const [entry] = rows ? archiveEntries(rows, state.services) : [];
      const scoped = entry ? scopedArchiveEntry(currentActor, entry) : undefined;
      if (!rows || !scoped) throw DENIED();
      // Archive reads await I/O; authorize again against the current scope before recording access.
      const currentState = await store.readState();
      const auditedActor = requireActiveUser(currentState, currentActor);
      const currentEntry = archiveEntries(rows, currentState.services)[0];
      const currentScoped = currentEntry ? scopedArchiveEntry(auditedActor, currentEntry) : undefined;
      if (!currentScoped) throw DENIED();
      const view = archivedRequestView(currentState, auditedActor, rows, currentScoped);
      const resultVersionIds = view.items.flatMap((item) => item.results.flatMap((result) => result.versions.map((version) => version.id)));
      await store.appendReadAudit(createAudit("ArchivedRequestRead", auditedActor.id, "DiagnosticRequest", requestId, correlationId, undefined, undefined, { archived: true, resultVersionIds: JSON.stringify(resultVersionIds), versionCount: resultVersionIds.length }));
      const finalRows = await store.readArchivedRequest(requestId);
      if (!finalRows) throw DENIED();
      const finalState = await store.readState();
      const finalActor = requireActiveUser(finalState, auditedActor);
      const finalEntry = archiveEntries(finalRows, finalState.services)[0];
      const finalScoped = finalEntry ? scopedArchiveEntry(finalActor, finalEntry) : undefined;
      if (!finalScoped) throw DENIED();
      return archivedRequestView(finalState, finalActor, finalRows, finalScoped);
    }
  };
}

/** Resolves an immutable archived attachment with the same download scope as active data. */
export function archivedAttachmentForActor(state: StoreState, actor: User, rows: readonly ClinicalArchiveRow[] | undefined, attachmentId: string): { attachment: Attachment; version: ResultVersion; request: DiagnosticRequest } {
  const unavailable = () => new ApiError("NOT_FOUND", "Anexo não disponível.", 404);
  if (!rows) throw unavailable();
  const attachment = archivedEntitiesOf<Attachment>(rows, "attachments").find((entry) => entry.id === attachmentId);
  const version = attachment ? archivedEntitiesOf<ResultVersion>(rows, "resultVersions").find((entry) => entry.id === attachment.resultVersionId) : undefined;
  const result = version ? archivedEntitiesOf<Result>(rows, "results").find((entry) => entry.id === version.resultId) : undefined;
  const item = result ? archivedEntitiesOf<DiagnosticItem>(rows, "items").find((entry) => entry.id === result.itemId) : undefined;
  const request = archivedEntitiesOf<DiagnosticRequest>(rows, "requests")[0];
  if (!attachment || !version || !item || !request || !["RELEASED", "SUPERSEDED"].includes(version.status) || attachment.uploadStatus !== "FINALIZED" || attachment.scanStatus !== "CLEAN") throw unavailable();
  const serviceCode = findById(state.services, item.serviceId)?.code ?? item.serviceId;
  const resource = { patientId: request.patientId, departmentCode: item.departmentCode, serviceCode };
  requirePermission(actor, "attachment.download", resource);
  requirePermission(actor, "attachment.view", resource);
  if (!canViewArchivedItem(actor, request.patientId, { departmentCode: item.departmentCode, serviceCode })) throw DENIED();
  return { attachment, version, request };
}

function archivedRequestView(state: StoreState, actor: User, rows: readonly ClinicalArchiveRow[], entry: ClinicalArchiveEntry): ArchivedRequestView {
  const [request] = archivedEntitiesOf<DiagnosticRequest>(rows, "requests");
  const serviceById = new Map(state.services.map((service) => [service.id, service]));
  const resultsByItem = new Map<string, Result[]>();
  for (const result of archivedEntitiesOf<Result>(rows, "results")) resultsByItem.set(result.itemId, [...(resultsByItem.get(result.itemId) ?? []), result]);
  const versions = archivedEntitiesOf<ResultVersion>(rows, "resultVersions");
  const allItems = archivedEntitiesOf<DiagnosticItem>(rows, "items");
  // Every profile sees only the items it could open in the active aggregate; results, versions, samples and attachments follow the visible items.
  const items = allItems.filter((item) => canViewArchivedItem(actor, request.patientId, { departmentCode: item.departmentCode, serviceCode: serviceById.get(item.serviceId)?.code ?? item.serviceId }));
  const visibleVersionIds = new Set<string>();
  const patient = findById(state.patients, request.patientId);
  return {
    readOnly: true,
    archivedAt: entry.archivedAt,
    request: {
      id: request.id,
      requestCode: request.requestCode,
      patientId: request.patientId,
      encounterId: request.encounterId,
      requestingDepartmentCode: request.requestingDepartmentCode,
      priority: request.priority,
      aggregateStatus: request.aggregateStatus,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
    },
    patient: patient ? { id: patient.id, displayName: patient.displayName, species: patient.species, externalId: patient.externalId } : null,
    items: items.map((item) => ({
      id: item.id,
      service: { code: serviceById.get(item.serviceId)?.code ?? item.serviceId, name: serviceById.get(item.serviceId)?.name ?? item.serviceId },
      departmentCode: item.departmentCode,
      status: item.status,
      priority: item.priority,
      requestedAt: item.requestedAt,
      ...(item.completedAt ? { completedAt: item.completedAt } : {}),
      ...(item.cancellationReason ? { cancellationReason: item.cancellationReason } : {}),
      ...(item.rejectionReason ? { rejectionReason: item.rejectionReason } : {}),
      ...(item.note ? { note: item.note } : {}),
      results: (resultsByItem.get(item.id) ?? []).map((result) => ({
        id: result.id,
        lifecycleStatus: result.lifecycleStatus,
        // Drafts never leave the active workflow; only released history is read-only visible.
        versions: versions
          .filter((version) => version.resultId === result.id && version.status !== "DRAFT")
          .map((version) => {
            if (["RELEASED", "SUPERSEDED"].includes(version.status)) visibleVersionIds.add(version.id);
            return {
              id: version.id,
              sequence: version.sequence,
              status: version.status,
              content: version.content,
              narrative: version.narrative,
              ...(version.conclusion ? { conclusion: version.conclusion } : {}),
              ...(version.releasedAt ? { releasedAt: version.releasedAt } : {}),
              critical: version.critical,
              ...(version.amendmentReason ? { amendmentReason: version.amendmentReason } : {})
            };
          })
      }))
    })),
    samples: archivedEntitiesOf<Sample>(rows, "samples")
      .filter((sample) => sample.itemIds.some((itemId) => items.some((item) => item.id === itemId)))
      .map((sample) => ({ id: sample.id, accessionCode: sample.accessionCode, sampleType: sample.sampleType, status: sample.status, ...(sample.collectedAt ? { collectedAt: sample.collectedAt } : {}), ...(sample.receivedAt ? { receivedAt: sample.receivedAt } : {}) })),
    attachments: archivedEntitiesOf<Attachment>(rows, "attachments")
      .filter((attachment) => visibleVersionIds.has(attachment.resultVersionId) && attachment.uploadStatus === "FINALIZED" && attachment.scanStatus === "CLEAN")
      .map((attachment) => ({ id: attachment.id, resultVersionId: attachment.resultVersionId, safeName: attachment.safeName, detectedMime: attachment.detectedMime, sizeBytes: attachment.sizeBytes }))
  };
}
