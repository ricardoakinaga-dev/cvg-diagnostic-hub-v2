import type { DiagnosticItem, DiagnosticRequest, Encounter, Notification, Patient, Procedure, ProcedureSchedule, Result, ResultVersion, Sample, StoreState } from "../src/server/domain/models";

/** D2 (08/10/2026): up to 150 exams a day; the PROD-110 load target is the volume after 12 months. */
export const D2_EXAMS_PER_DAY = 150;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_MONTHS = 36;
// Two exams per request (a hemogram and a thorax X-ray), and about four requests per patient over the period.
const ITEMS_PER_REQUEST = 2;
const REQUESTS_PER_PATIENT = 4;
const SPECIES = [["Canino", "SRD"], ["Felino", "SRD"], ["Canino", "Labrador"], ["Felino", "Siamês"]] as const;

export interface ClinicalVolumeOptions {
  readonly months: number;
  readonly examsPerDay?: number;
  /** Requests of the last `activeDays` days stay open (REQUESTED); everything older is completed with results. */
  readonly activeDays?: number;
  readonly now?: Date;
}

export interface ClinicalVolumeSummary {
  readonly months: number;
  readonly examsPerDay: number;
  readonly days: number;
  readonly patients: number;
  readonly requests: number;
  readonly items: number;
  readonly activeRequests: number;
}

/**
 * Appends a synthetic clinical history to `state` (in place, for speed at 55 thousand exams): requests spread
 * evenly over `months`, each with a laboratory item (sample, result with an amended version, acknowledged
 * notification) and a radiology item (procedure and schedule), like the archive fixtures but with unique IDs
 * and codes. Deterministic for the same options; nothing in it is real patient data.
 */
export function addClinicalVolume(state: StoreState, options: ClinicalVolumeOptions): ClinicalVolumeSummary {
  const { months } = options;
  const examsPerDay = options.examsPerDay ?? D2_EXAMS_PER_DAY;
  const activeDays = options.activeDays ?? 2;
  if (!Number.isSafeInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`CLINICAL_VOLUME_INVALID_MONTHS: 1 to ${MAX_MONTHS}`);
  if (!Number.isSafeInteger(examsPerDay) || examsPerDay < ITEMS_PER_REQUEST || examsPerDay > 2_000) throw new Error("CLINICAL_VOLUME_INVALID_RATE: 2 to 2000 exams a day");
  if (!Number.isSafeInteger(activeDays) || activeDays < 0 || activeDays > 30) throw new Error("CLINICAL_VOLUME_INVALID_ACTIVE_DAYS: 0 to 30");
  const now = (options.now ?? new Date()).getTime();
  const days = Math.round(months * 30.4375);
  const requestsPerDay = Math.floor(examsPerDay / ITEMS_PER_REQUEST);
  const requests = days * requestsPerDay;
  const patients = Math.ceil(requests / REQUESTS_PER_PATIENT);
  const iso = (ms: number) => new Date(ms).toISOString();
  const start = now - days * DAY_MS;

  for (let index = 0; index < patients; index++) {
    const [species, breed] = SPECIES[index % SPECIES.length]!;
    const patient: Patient = { id: `patient-vol-${index}`, displayName: `Paciente ${index}`, species, breed, sex: index % 2 ? "Fêmea" : "Macho", ownerLabel: `Tutor ${index}`, externalId: `VOL-PATIENT-${index}`, active: true };
    const encounter: Encounter = { id: `encounter-vol-${index}`, patientId: patient.id, externalId: `VOL-ENCOUNTER-${index}`, type: "OUTPATIENT", status: "OPEN", openedAt: iso(start) };
    state.patients.push(patient);
    state.encounters.push(encounter);
  }

  let activeRequests = 0;
  for (let index = 0; index < requests; index++) {
    const day = Math.floor(index / requestsPerDay);
    // Spread the day's requests between 07:00 and 19:00.
    const createdMs = start + day * DAY_MS + 7 * HOUR_MS + Math.floor(((index % requestsPerDay) * 12 * HOUR_MS) / requestsPerDay);
    const at = iso(createdMs);
    const patientIndex = index % patients;
    const key = `vol-${index}`;
    const requestId = `request-${key}`;
    const active = createdMs >= now - activeDays * DAY_MS;
    const labItem: DiagnosticItem = {
      id: `item-lab-${key}`, requestId, serviceId: "service-hemogram", departmentCode: "LABORATORY", workflowType: "LABORATORY", priority: "ROUTINE",
      status: "REQUESTED", requestedAt: at, slaStartedAt: at, dueAt: iso(createdMs + 8 * HOUR_MS), slaPolicyVersion: 1, version: 1
    };
    const imagingItem: DiagnosticItem = {
      id: `item-rx-${key}`, requestId, serviceId: "service-xray", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", priority: "ROUTINE",
      status: "REQUESTED", requestedAt: at, slaStartedAt: at, dueAt: iso(createdMs + 24 * HOUR_MS), slaPolicyVersion: 1, version: 1
    };
    const request: DiagnosticRequest = {
      id: requestId, requestCode: `EX-V${index}`, patientId: `patient-vol-${patientIndex}`, encounterId: `encounter-vol-${patientIndex}`, requesterId: "user-vet",
      requestingDepartmentCode: "INPATIENT", priority: "ROUTINE", aggregateStatus: "REQUESTED", itemIds: [labItem.id, imagingItem.id], createdAt: at, updatedAt: at, version: 1
    };
    if (active) {
      activeRequests++;
      state.requests.push(request);
      state.items.push(labItem, imagingItem);
      continue;
    }
    const done = iso(createdMs + 6 * HOUR_MS);
    const completed = { status: "COMPLETED" as const, completedAt: done, version: 3 };
    const sample: Sample = { id: `sample-${key}`, requestId, accessionCode: `ACC-V${index}`, sampleType: "EDTA", status: "RECEIVED", itemIds: [labItem.id], collectedAt: at, receivedAt: at, version: 2 };
    const procedure: Procedure = { id: `procedure-${key}`, itemId: imagingItem.id, workflowType: "RADIOLOGY", status: "PERFORMED", scheduleIds: [`schedule-${key}`], performedAt: done, version: 2 };
    const schedule: ProcedureSchedule = { id: `schedule-${key}`, procedureId: procedure.id, startsAt: at, endsAt: done, resource: "RX-1", status: "COMPLETED", actorId: "user-rx", createdAt: at, version: 1 };
    const result: Result = { id: `result-${key}`, itemId: labItem.id, currentVersionId: `version-${key}-2`, lifecycleStatus: "RELEASED", needsReReview: false, version: 3 };
    const draft: ResultVersion = { id: `version-${key}-1`, resultId: result.id, sequence: 1, status: "SUPERSEDED", content: { kind: "NARRATIVE" }, narrative: "Primeira versão.", authorId: "user-lab", createdAt: at, releasedAt: at, critical: false, needsReReview: false, version: 2 };
    const released: ResultVersion = { id: `version-${key}-2`, resultId: result.id, sequence: 2, status: "RELEASED", content: { kind: "NARRATIVE" }, narrative: "Versão final.", conclusion: "Sem alterações.", authorId: "user-lab", createdAt: done, releasedAt: done, supersedesId: draft.id, amendmentReason: "Correção", critical: false, needsReReview: false, version: 2 };
    const notification: Notification = {
      id: `notification-${key}`, category: "ACTIONABLE", priority: "NORMAL", recipientUserId: "user-vet", entityType: "RESULT_VERSION", entityId: released.id, deepLink: `/results/${result.id}`,
      title: "Resultado liberado", body: "Resultado liberado.", dedupeKey: `dedupe-${key}`, state: "ACKNOWLEDGED", createdAt: done, attempts: 1, version: 2
    };
    state.requests.push({ ...request, aggregateStatus: "COMPLETED", updatedAt: done, version: 4 });
    state.items.push({ ...labItem, ...completed, currentResultId: result.id, currentSampleId: sample.id }, { ...imagingItem, ...completed, procedureId: procedure.id });
    state.samples.push(sample);
    state.procedures.push(procedure);
    state.schedules.push(schedule);
    state.results.push(result);
    state.resultVersions.push(draft, released);
    state.notifications.push(notification);
  }
  return { months, examsPerDay, days, patients, requests, items: requests * ITEMS_PER_REQUEST, activeRequests };
}
