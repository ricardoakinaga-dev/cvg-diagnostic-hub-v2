import { createHash, randomUUID } from "node:crypto";
import type { ExamDefinition, ExamDefinitionSnapshot, ExamDefinitionVersion } from "@cvg/contracts";
import type { DiagnosticItem, DiagnosticService, Patient, ResultVersion, StoreState } from "../domain/models";
import { ApiError } from "../http/envelope";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function examDefinitionId(service: Pick<DiagnosticService, "id" | "version">): string {
  return `exam-definition-${createHash("sha256").update(`${service.id}\0${service.version}`).digest("hex")}`;
}

export function definitionOf(service: DiagnosticService): ExamDefinition {
  return structuredClone({ code: service.code, name: service.name, category: service.category, departmentCode: service.departmentCode, workflowType: service.workflowType, requiresSample: service.requiresSample, ...(service.sampleType ? { sampleType: service.sampleType } : {}), requiresSchedule: service.requiresSchedule, allowsAttachment: service.allowsAttachment, resultSchema: service.resultSchema, ...(service.resultTemplate ? { resultTemplate: service.resultTemplate } : {}), slaHours: service.slaHours });
}

export function definitionStatus(service: DiagnosticService): ExamDefinitionVersion["status"] {
  if (!service.active) return "RETIRED";
  if (service.resultSchema === "NUMERIC_PANEL") return service.resultTemplate?.status ?? "DRAFT";
  return "ACTIVE";
}

function recordRevision(state: StoreState, service: DiagnosticService, actorId: string, recordedAt: string, correlationId: string, provenance: ExamDefinitionVersion["provenance"]): StoreState {
  const definition = definitionOf(service);
  const status = definitionStatus(service);
  const existing = state.examDefinitions.find((entry) => entry.serviceId === service.id && entry.serviceVersion === service.version);
  if (existing) {
    if (existing.status !== status || canonical(existing.definition) !== canonical(definition)) throw new ApiError("DEFINITION_VERSION_CONFLICT", "A revisão registrada do exame não pode ser sobrescrita.", 409);
    return state;
  }
  const revision: ExamDefinitionVersion = { id: examDefinitionId(service), serviceId: service.id, serviceVersion: service.version, status, recordedAt, recordedBy: actorId, provenance, definition };
  return { ...state, examDefinitions: [...state.examDefinitions, revision], auditEvents: [...state.auditEvents, { id: `audit-${randomUUID()}`, eventType: "ExamDefinitionRecorded", actorId, entityType: "ExamDefinitionVersion", entityId: revision.id, correlationId, occurredAt: recordedAt, metadata: { serviceId: service.id, serviceVersion: service.version, status, provenance } }] };
}

/** Call after constructing the next catalog state, before saving the command's idempotency response. */
export function recordExamDefinition(state: StoreState, previous: DiagnosticService | undefined, next: DiagnosticService, actorId: string, recordedAt: string, correlationId: string): StoreState {
  const observed = previous ? recordRevision(state, previous, actorId, recordedAt, correlationId, "CATALOG_OBSERVATION") : state;
  return recordRevision(observed, next, actorId, recordedAt, correlationId, "CATALOG_WRITE");
}

export function captureExamDefinition(state: StoreState, service: DiagnosticService, patient: Pick<Patient, "species" | "sex" | "birthDate">, actorId: string, capturedAt: string, correlationId: string, provenance: ExamDefinitionSnapshot["provenance"]): { state: StoreState; snapshot: ExamDefinitionSnapshot } {
  if (provenance === "REQUEST_CAPTURE" && definitionStatus(service) !== "ACTIVE") throw new ApiError("EXAM_DEFINITION_NOT_PUBLISHED", "A definição deste exame não está publicada para novos pedidos.", 422);
  const next = recordRevision(state, service, actorId, capturedAt, correlationId, "CATALOG_OBSERVATION");
  const snapshot: ExamDefinitionSnapshot = { schemaVersion: 1, capturedAt, provenance, definitionId: examDefinitionId(service), serviceId: service.id, serviceVersion: service.version, definition: definitionOf(service), patientContext: { species: patient.species, ...(patient.sex ? { sex: patient.sex } : {}), ...(patient.birthDate ? { birthDate: patient.birthDate } : {}) } };
  return { state: next, snapshot };
}

/** A later capture for a legacy request is never evidence of an earlier result's definition. */
export function snapshotForResult(item: DiagnosticItem, version: ResultVersion): ExamDefinitionSnapshot | undefined {
  if (version.definitionSnapshot) return version.definitionSnapshot;
  const capture = item.definitionSnapshot;
  return capture?.provenance === "REQUEST_CAPTURE" && capture.serviceId === item.serviceId && Date.parse(version.createdAt) >= Date.parse(capture.capturedAt) ? capture : undefined;
}

export function definitionForCommand(state: StoreState, item: DiagnosticItem, version: ResultVersion | undefined, actorId: string, capturedAt: string, correlationId: string) {
  const snapshot = version ? snapshotForResult(item, version) : item.definitionSnapshot?.provenance === "REQUEST_CAPTURE" ? item.definitionSnapshot : undefined;
  if (snapshot) return { state, snapshot: structuredClone(snapshot) };
  const service = state.services.find((entry) => entry.id === item.serviceId);
  const request = state.requests.find((entry) => entry.id === item.requestId);
  const patient = state.patients.find((entry) => entry.id === request?.patientId);
  if (!service || !patient) throw new ApiError("NOT_FOUND", "O contexto deste exame não está disponível.", 404);
  return captureExamDefinition(state, service, patient, actorId, capturedAt, correlationId, "COMMAND_CAPTURE_LEGACY_REQUEST");
}

export function serviceWithDefinition(service: DiagnosticService, snapshot: ExamDefinitionSnapshot | undefined): DiagnosticService {
  if (!snapshot) return service;
  const { sampleType: _sampleType, resultTemplate: _template, ...base } = service;
  return { ...base, ...structuredClone(snapshot.definition), version: snapshot.serviceVersion };
}
