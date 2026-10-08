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

/** Same scope rules as the active aggregate, applied to the archived summary (PROD-501). */
function canViewArchiveEntry(actor: User, entry: ClinicalArchiveEntry): boolean {
  if (actor.role === "MANAGER") {
    return (managerCanAccessDepartment(actor, entry.requestingDepartmentCode) || entry.services.some((service) => managerCanAccessDepartment(actor, service.departmentCode)))
      && canAccessResource(actor, "request.view", {});
  }
  if (isExecutorRole(actor)) {
    return entry.services.some((service) => canAccessResource(actor, "item.view", { patientId: entry.patientId, departmentCode: service.departmentCode, serviceCode: service.code }));
  }
  return canAccessResource(actor, "request.view", { patientId: entry.patientId, departmentCode: entry.requestingDepartmentCode });
}

export function createArchiveService({ store }: ApplicationServiceContext) {
  return {
    async listPatientArchive(actor: User, patientId: string, filters: { limit?: number } = {}): Promise<ClinicalArchiveEntry[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const limit = pageSize(filters.limit);
      if (!findById(state.patients, patientId)) throw DENIED();
      const visible = (await store.readClinicalArchive({ patientId, limit })).filter((entry) => canViewArchiveEntry(currentActor, entry));
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
      if (!rows || !entry || !canViewArchiveEntry(currentActor, entry)) throw DENIED();
      return archivedRequestView(state, currentActor, rows, entry);
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
  const items = allItems.filter((item) => !isExecutorRole(actor) || canAccessResource(actor, "item.view", {
    patientId: request.patientId,
    departmentCode: item.departmentCode,
    serviceCode: serviceById.get(item.serviceId)?.code ?? item.serviceId
  }));
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
      .filter((sample) => !isExecutorRole(actor) || sample.itemIds.some((itemId) => items.some((item) => item.id === itemId)))
      .map((sample) => ({ id: sample.id, accessionCode: sample.accessionCode, sampleType: sample.sampleType, status: sample.status, ...(sample.collectedAt ? { collectedAt: sample.collectedAt } : {}), ...(sample.receivedAt ? { receivedAt: sample.receivedAt } : {}) })),
    attachments: archivedEntitiesOf<Attachment>(rows, "attachments")
      .filter((attachment) => visibleVersionIds.has(attachment.resultVersionId))
      .map((attachment) => ({ id: attachment.id, resultVersionId: attachment.resultVersionId, safeName: attachment.safeName, detectedMime: attachment.detectedMime, sizeBytes: attachment.sizeBytes }))
  };
}
