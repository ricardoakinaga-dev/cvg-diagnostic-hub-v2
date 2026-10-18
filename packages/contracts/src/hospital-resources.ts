export const HOSPITAL_RESOURCE_KINDS = ["PROFESSIONAL", "ROOM", "EQUIPMENT", "BED"] as const;
export type HospitalResourceKind = (typeof HOSPITAL_RESOURCE_KINDS)[number];
export const HOSPITAL_RESOURCE_AVAILABILITY = ["AVAILABLE", "BLOCKED", "MAINTENANCE"] as const;
export type HospitalResourceAvailability = (typeof HOSPITAL_RESOURCE_AVAILABILITY)[number];
export interface HospitalResourceWindow { startsAt: string; endsAt: string }
/** Inventory is metadata. An available resource does not authorize a patient or a clinical action. */
export interface HospitalResource {
  id: string; code: string; name: string; kind: HospitalResourceKind; departmentCode: string;
  userId?: string; ward?: string; bedLabel?: string; allowedSpecies?: string[];
  availability: HospitalResourceAvailability; availabilityWindows: HospitalResourceWindow[];
  active: boolean; version: number; createdAt: string; updatedAt: string;
}
export interface HospitalResourceSnapshot {
  resourceId: string; resourceVersion: number; code: string; name: string;
  kind: HospitalResourceKind; departmentCode: string; userId?: string; capturedAt: string;
}
export interface HospitalResourceFilters {
  departmentCode?: string; kind?: HospitalResourceKind; includeInactive?: boolean;
  query?: string; limit?: number; cursor?: string;
}
export interface HospitalResourcePage { items: HospitalResource[]; total: number; nextCursor?: string }
export interface HospitalResourceOptions { departments: Array<{ code: string; name: string }>; professionals: Array<{ id: string; displayName: string; departmentCode: string }> }
/** Stored in the existing schedules collection; precisely one target identifies its authority. */
export interface HospitalSchedule {
  id: string; procedureId?: string; hospitalTaskId?: string; startsAt: string; endsAt: string;
  /** Original display text for legacy reservations; it is never inferred as an inventory ID. */
  resource: string; resourceIds?: string[]; resourceSnapshots?: HospitalResourceSnapshot[];
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED"; reason?: string;
  actorId: string; createdAt: string; version: number;
}
export interface HospitalCalendarFilters {
  departmentCode?: string; resourceId?: string; from: string; to: string;
  kinds?: Array<"RESERVATION" | "DEADLINE" | "EXECUTION">; limit?: number; cursor?: string;
}
export interface HospitalCalendarEvent {
  id: string; kind: "RESERVATION" | "DEADLINE" | "EXECUTION";
  targetType: "DIAGNOSTIC_ITEM" | "HOSPITAL_TASK"; targetId: string;
  departmentCode: string; label: string; startsAt: string; endsAt?: string;
  schedule?: HospitalSchedule; dueAt?: string; deepLink: string;
}
export interface HospitalCalendarPage { items: HospitalCalendarEvent[]; total: number; nextCursor?: string }
export interface HospitalBedCensusRow {
  resource: HospitalResource;
  state: "AVAILABLE" | "OCCUPIED" | "RESTRICTED_OCCUPANCY" | "UNRECONCILED" | "BLOCKED" | "MAINTENANCE" | "INACTIVE";
  occupancy?: { admissionId: string; encounterId: string; patientId: string; patientName: string; admittedAt: string; responsibleUserId?: string; version: number; openDiagnosticItemCount: number; openHospitalTaskCount: number };
}
export interface HospitalBedCensus {
  asOf: string; beds: HospitalBedCensusRow[];
  /** Legacy open admissions are visible only within the actor's patient scope. */
  unregisteredAdmissions: Array<{ admissionId: string; patientId: string; patientName: string; departmentCode: string; ward: string; bed: string; version: number }>;
  dischargedWithPendingWork: Array<{ admissionId: string; patientId: string; patientName: string; openDiagnosticItemCount: number; openHospitalTaskCount: number }>;
}
export interface HospitalCapacityFilters { departmentCode?: string; from: string; to: string }
export interface HospitalResourceCapacity {
  resourceId: string; code: string; name: string; kind: HospitalResourceKind;
  departmentCode: string; unit: "MINUTES" | "BEDS"; nominal: number | null;
  reserved: number; available: number | null; unavailable: number | null;
  availabilityKnown: boolean; reason?: "CALENDAR_NOT_CONFIGURED" | "RESOURCE_UNAVAILABLE" | "LEGACY_OCCUPANCY_NOT_LINKED" | "EXECUTION_END_UNKNOWN";
}
export interface HospitalCapacityView {
  from: string; to: string; asOf: string; resources: HospitalResourceCapacity[];
  /** Current authorized open load, independent of the resource window. Effort is null if
   * any included object lacks an explicit estimate; diagnostic deadlines are not estimates.
   * Empty load is zero. Private drafts, archived and terminal tasks are excluded. */
  authorizedLoad: { openDiagnosticItems: number; overdueDiagnosticItems: number; openHospitalTasks: number; estimatedMinutes: number | null };
  sla: { source: "REQUEST_CAPTURE"; unit: "ELAPSED_HOURS"; calendarPausesDeadline: false };
}
