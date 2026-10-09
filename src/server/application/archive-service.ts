import type { ClinicalArchiveEntry, ClinicalArchiveRow, DiagnosticItem, DiagnosticRequest, Result, ResultVersion, Sample, Attachment, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource, hasPermission, managerCanAccessDepartment } from "../security/authorization";
import { findById } from "../domain/state-index";
import { archiveEntries, archivedEntitiesOf } from "../domain/clinical-archive";
import { isExecutorRole, requireActiveUser, requirePatientPermission } from "./service-common";
import { pageSize } from "./service-pagination";
import type { ApplicationServiceContext } from "./service-context";
import type { ArchivedRequestView } from "./service-types";

const DENIED = () => new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);

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

export function createArchiveService({ store }: ApplicationServiceContext) {
  return {
    async listPatientArchive(actor: User, patientId: string, filters: { limit?: number } = {}): Promise<ClinicalArchiveEntry[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const limit = pageSize(filters.limit);
      if (!findById(state.patients, patientId)) throw DENIED();
      // Scope first, then page (AUD-08): a newer record of another department must not hide an older visible one.
      const visible = (await store.readClinicalArchive({ patientId }))
        .map((entry) => scopedArchiveEntry(currentActor, entry))
        .filter((entry): entry is ClinicalArchiveEntry => entry !== undefined)
        .slice(0, limit);
      for (const permission of ["patient.view", "diagnostic.timeline.view"] as const) {
        try {
          requirePatientPermission(state, currentActor, permission, patientId);
        } catch (error) {
          // A manager or executor whose only context for this patient is archived reads what the archive scope allows.
          const archiveOnly = (currentActor.role === "MANAGER" || isExecutorRole(currentActor)) && visible.length > 0 && hasPermission(currentActor.role, permission);
          if (!archiveOnly) throw error;
        }
      }
      return visible;
    },

    async getArchivedRequest(actor: User, requestId: string): Promise<ArchivedRequestView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const rows = await store.readArchivedRequest(requestId);
      const [entry] = rows ? archiveEntries(rows, state.services) : [];
      const scoped = entry ? scopedArchiveEntry(currentActor, entry) : undefined;
      if (!rows || !scoped) throw DENIED();
      return archivedRequestView(state, currentActor, rows, scoped);
    }
  };
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
            visibleVersionIds.add(version.id);
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
      .filter((attachment) => visibleVersionIds.has(attachment.resultVersionId))
      .map((attachment) => ({ id: attachment.id, resultVersionId: attachment.resultVersionId, safeName: attachment.safeName, detectedMime: attachment.detectedMime, sizeBytes: attachment.sizeBytes }))
  };
}
