import type { Attachment, ClinicalArchiveRow, DiagnosticItem, DiagnosticRequest, DiagnosticService, Patient, Result, ResultVersion, Sample, StoreState, User } from "../domain/models";
import { archivedEntitiesOf } from "../domain/clinical-archive";
import { encountersForPatient, requestsForPatient } from "../domain/state-index";
import { ApiError } from "../http/envelope";
import { createAudit, id, requireActiveUser, requirePermission, requireRecentReauthentication } from "./service-common";
import type { ApplicationServiceContext } from "./service-context";

/** Archived requests read per round trip while gathering a patient's archive for an export. */
const ARCHIVE_EXPORT_PAGE = 100;

export const PATIENT_DATA_EXPORT_FORMAT = "cvg-hub.patient-data-export.v1";

/** What an export deliberately leaves out, stated in the file so the titular knows (D-048). */
export const PATIENT_DATA_EXPORT_OMITS = Object.freeze([
  "identidade da equipe (nomes, e-mails e identificadores de quem solicitou, colheu, laudou ou revisou)",
  "rascunhos de resultado nunca liberados",
  "trilha de auditoria interna e notificações da equipe",
  "conteúdo dos anexos (o arquivo é entregue à parte pelo hospital) e chaves de armazenamento"
]);

export interface ExportedResultVersion {
  sequence: number;
  status: ResultVersion["status"];
  releasedAt?: string;
  narrative: string;
  conclusion?: string;
  content: Record<string, unknown>;
  critical: boolean;
  amendmentReason?: string;
}

export interface ExportedItem {
  service: { code: string; name: string };
  departmentCode: string;
  status: DiagnosticItem["status"];
  priority: DiagnosticItem["priority"];
  requestedAt: string;
  completedAt?: string;
  cancellationReason?: string;
  rejectionReason?: string;
  samples: Array<{ accessionCode: string; sampleType: string; status: Sample["status"]; collectedAt?: string; receivedAt?: string }>;
  results: Array<{ status: Result["lifecycleStatus"]; versions: ExportedResultVersion[] }>;
  attachments: Array<{ safeName: string; detectedMime: string; sizeBytes: number; createdAt: string }>;
}

export interface ExportedRequest {
  requestCode: string;
  encounterExternalId?: string;
  requestingDepartmentCode: string;
  priority: DiagnosticRequest["priority"];
  status: DiagnosticRequest["aggregateStatus"];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  items: ExportedItem[];
}

export interface PatientDataExport {
  format: typeof PATIENT_DATA_EXPORT_FORMAT;
  exportedAt: string;
  patient: Pick<Patient, "externalId" | "displayName" | "species" | "breed" | "sex" | "ownerLabel" | "active"> & { birthDate?: string };
  encounters: Array<{ externalId: string; type: string; status: string; openedAt: string; closedAt?: string }>;
  admissions: Array<{ encounterExternalId?: string; departmentCode: string; ward: string; bed: string; admittedAt: string; dischargedAt?: string }>;
  requests: ExportedRequest[];
  omitted: readonly string[];
}

/** The entities of one request, wherever they live (active aggregate or archive rows). */
interface RequestBundle {
  request: DiagnosticRequest;
  items: DiagnosticItem[];
  samples: Sample[];
  results: Result[];
  versions: ResultVersion[];
  attachments: Attachment[];
  archived: boolean;
}

function exportRequest(bundle: RequestBundle, services: ReadonlyMap<string, DiagnosticService>, encounterExternalIds: ReadonlyMap<string, string>): ExportedRequest {
  const { request } = bundle;
  const exportedVersions = (resultId: string): ExportedResultVersion[] => bundle.versions
    .filter((version) => version.resultId === resultId && version.status !== "DRAFT")
    .sort((left, right) => left.sequence - right.sequence)
    .map((version) => ({
      sequence: version.sequence,
      status: version.status,
      ...(version.releasedAt ? { releasedAt: version.releasedAt } : {}),
      narrative: version.narrative,
      ...(version.conclusion ? { conclusion: version.conclusion } : {}),
      content: version.content,
      critical: version.critical,
      ...(version.amendmentReason ? { amendmentReason: version.amendmentReason } : {})
    }));
  const items = bundle.items.map((item): ExportedItem => {
    const service = services.get(item.serviceId);
    const results = bundle.results.filter((result) => result.itemId === item.id);
    const versionIds = new Set(results.flatMap((result) => bundle.versions.filter((version) => version.resultId === result.id && version.status !== "DRAFT").map((version) => version.id)));
    return {
      service: { code: service?.code ?? item.serviceId, name: service?.name ?? item.serviceId },
      departmentCode: item.departmentCode,
      status: item.status,
      priority: item.priority,
      requestedAt: item.requestedAt,
      ...(item.completedAt ? { completedAt: item.completedAt } : {}),
      ...(item.cancellationReason ? { cancellationReason: item.cancellationReason } : {}),
      ...(item.rejectionReason ? { rejectionReason: item.rejectionReason } : {}),
      samples: bundle.samples.filter((sample) => sample.itemIds.includes(item.id)).map((sample) => ({
        accessionCode: sample.accessionCode,
        sampleType: sample.sampleType,
        status: sample.status,
        ...(sample.collectedAt ? { collectedAt: sample.collectedAt } : {}),
        ...(sample.receivedAt ? { receivedAt: sample.receivedAt } : {})
      })),
      results: results
        .map((result) => ({ status: result.lifecycleStatus, versions: exportedVersions(result.id) }))
        .filter((result) => result.versions.length > 0),
      attachments: bundle.attachments
        .filter((attachment) => versionIds.has(attachment.resultVersionId) && attachment.uploadStatus === "FINALIZED")
        .map((attachment) => ({ safeName: attachment.safeName, detectedMime: attachment.detectedMime, sizeBytes: attachment.sizeBytes, createdAt: attachment.createdAt }))
    };
  });
  const encounterExternalId = encounterExternalIds.get(request.encounterId);
  return {
    requestCode: request.requestCode,
    ...(encounterExternalId ? { encounterExternalId } : {}),
    requestingDepartmentCode: request.requestingDepartmentCode,
    priority: request.priority,
    status: request.aggregateStatus,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    archived: bundle.archived,
    items
  };
}

/**
 * The titular's data for one patient (PROD-502, D-048): the registration, encounters, admissions and every request
 * with its exams, samples, released results and attachment metadata, active or archived, newest first. Pure: the
 * service gathers the archive rows and writes the audit event.
 */
export function buildPatientDataExport(state: StoreState, patient: Patient, archived: ReadonlyArray<readonly ClinicalArchiveRow[]>, exportedAt: string): PatientDataExport {
  const services = new Map(state.services.map((service) => [service.id, service]));
  const encounters = encountersForPatient(state, patient.id);
  const encounterExternalIds = new Map(encounters.map((encounter) => [encounter.id, encounter.externalId]));
  const encounterIds = new Set(encounters.map((encounter) => encounter.id));
  const active: RequestBundle[] = requestsForPatient(state, patient.id).map((request) => {
    const itemIds = new Set(request.itemIds);
    const results = state.results.filter((result) => itemIds.has(result.itemId));
    const resultIds = new Set(results.map((result) => result.id));
    const versions = state.resultVersions.filter((version) => resultIds.has(version.resultId));
    const versionIds = new Set(versions.map((version) => version.id));
    return {
      request,
      items: state.items.filter((item) => itemIds.has(item.id)),
      samples: state.samples.filter((sample) => sample.requestId === request.id),
      results,
      versions,
      attachments: state.attachments.filter((attachment) => versionIds.has(attachment.resultVersionId)),
      archived: false
    };
  });
  const fromArchive: RequestBundle[] = archived.flatMap((rows) => {
    const [request] = archivedEntitiesOf<DiagnosticRequest>(rows, "requests");
    if (!request || request.patientId !== patient.id) return [];
    return [{
      request,
      items: archivedEntitiesOf<DiagnosticItem>(rows, "items"),
      samples: archivedEntitiesOf<Sample>(rows, "samples"),
      results: archivedEntitiesOf<Result>(rows, "results"),
      versions: archivedEntitiesOf<ResultVersion>(rows, "resultVersions"),
      attachments: archivedEntitiesOf<Attachment>(rows, "attachments"),
      archived: true
    }];
  });
  const requests = [...active, ...fromArchive]
    .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt) || left.request.requestCode.localeCompare(right.request.requestCode))
    .map((bundle) => exportRequest(bundle, services, encounterExternalIds));
  return {
    format: PATIENT_DATA_EXPORT_FORMAT,
    exportedAt,
    patient: {
      externalId: patient.externalId,
      displayName: patient.displayName,
      species: patient.species,
      breed: patient.breed,
      sex: patient.sex,
      ...(patient.birthDate ? { birthDate: patient.birthDate } : {}),
      ownerLabel: patient.ownerLabel,
      active: patient.active
    },
    encounters: encounters.map((encounter) => ({
      externalId: encounter.externalId,
      type: encounter.type,
      status: encounter.status,
      openedAt: encounter.openedAt,
      ...(encounter.closedAt ? { closedAt: encounter.closedAt } : {})
    })),
    admissions: state.admissions.filter((admission) => encounterIds.has(admission.encounterId)).map((admission) => ({
      ...(encounterExternalIds.get(admission.encounterId) ? { encounterExternalId: encounterExternalIds.get(admission.encounterId) } : {}),
      departmentCode: admission.departmentCode,
      ward: admission.ward,
      bed: admission.bed,
      admittedAt: admission.admittedAt,
      ...(admission.dischargedAt ? { dischargedAt: admission.dischargedAt } : {})
    })),
    requests,
    omitted: PATIENT_DATA_EXPORT_OMITS
  };
}

export function createDataSubjectService({ store }: ApplicationServiceContext) {
  return {
    /**
     * LGPD export of the titular's data for the patient with this medical-record number (PROD-502, D-048). Only an
     * ADMIN after a recent reauthentication (the request reaches the hospital's data protection officer, who operates
     * it); the ADMIN has no clinical access otherwise. Every export is audited (PatientDataExported) before the data
     * leaves.
     */
    async exportPatientData(actor: User, externalId: string, meta: { correlationId?: string } = {}): Promise<PatientDataExport> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "patient.data_export", {});
      requireRecentReauthentication(currentActor);
      const normalized = externalId.trim().toUpperCase();
      if (!normalized || normalized.length > 100) throw new ApiError("VALIDATION_ERROR", "Informe o número do prontuário (até 100 caracteres).", 400);
      const patient = state.patients.find((entry) => entry.externalId.toUpperCase() === normalized);
      if (!patient) throw new ApiError("NOT_FOUND", "Nenhum paciente com este número de prontuário.", 404);
      const archived: ClinicalArchiveRow[][] = [];
      for (let offset = 0; ; offset += ARCHIVE_EXPORT_PAGE) {
        const page = await store.readClinicalArchive({ patientId: patient.id, limit: ARCHIVE_EXPORT_PAGE, offset });
        for (const entry of page) {
          const rows = await store.readArchivedRequest(entry.requestId);
          if (rows) archived.push(rows);
        }
        if (page.length < ARCHIVE_EXPORT_PAGE) break;
      }
      const exportedAt = new Date().toISOString();
      const result = buildPatientDataExport(state, patient, archived, exportedAt);
      const correlationId = meta.correlationId ?? id("corr");
      await store.transaction((current) => ({
        state: {
          ...current,
          auditEvents: [...current.auditEvents, createAudit("PatientDataExported", currentActor.id, "Patient", patient.id, correlationId, undefined, undefined, {
            requests: result.requests.filter((request) => !request.archived).length,
            archivedRequests: result.requests.filter((request) => request.archived).length
          })]
        },
        result: undefined
      }));
      return result;
    }
  };
}
