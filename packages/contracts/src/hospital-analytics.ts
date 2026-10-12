export const HOSPITAL_METRIC_CODES = ["TASK_CREATED", "TASK_COMPLETED", "TASK_PENDING", "TASK_CANCELLED", "DIAGNOSTIC_REQUESTED", "DIAGNOSTIC_EXECUTED", "DIAGNOSTIC_REVIEWED", "DIAGNOSTIC_PENDING", "DIAGNOSTIC_OVERDUE", "PLAN_CREATED", "PLAN_CLOSED", "SHIFT_STARTED", "ACTIVITY_HANDED_OVER"] as const;
export type HospitalMetricCode = (typeof HOSPITAL_METRIC_CODES)[number];
export type HospitalMetricTargetType = "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM" | "HOSPITAL_PLAN" | "HOSPITAL_SHIFT";
export interface HospitalMetricFilters { from: string; to: string; departmentCode?: string }
export interface HospitalMetricDefinition {
  code: HospitalMetricCode; label: string; version: "HPL-OPERATIONAL-1"; unit: "COUNT";
  source: string; denominator: "AUTHORIZED_UNIQUE_OBJECTS" | "AUTHORIZED_UNIQUE_ACTIVITIES";
  timeBasis: "EVENT_IN_WINDOW" | "COHORT_IN_WINDOW_CURRENT_STATE"; description: string;
  approval: "TECHNICAL_DEFINITION_REQUIRES_PILOT_ACCEPTANCE";
}
export interface HospitalMetricRow {
  targetType: HospitalMetricTargetType; id: string; label: string; departmentCode: string;
  occurredAt: string; status: string; deepLink: string;
}
export interface HospitalMetricRowPage { items: HospitalMetricRow[]; total: number; limit: number; nextCursor?: string }
export interface HospitalMetricValue { definition: HospitalMetricDefinition; value: number | null; availability: "AUTHORIZED" | "NOT_AUTHORIZED" }
export interface HospitalPlannerMetrics {
  asOf: string; window: HospitalMetricFilters & { convention: "START_INCLUSIVE_END_EXCLUSIVE" };
  scope: { departmentCodes: string[]; policy: "CURRENT_OBJECT_AUTHORIZATION" };
  values: HospitalMetricValue[];
}
export interface HospitalReportDefinition {
  id: string; name: string; ownerId: string; sharedDepartmentCode?: string;
  metricCode: HospitalMetricCode; metricDefinitionVersion: "HPL-OPERATIONAL-1";
  filters: HospitalMetricFilters; format: "CSV" | "JSONL"; active: boolean;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalReportJob {
  id: string; reportId: string; ownerId: string;
  definitionSnapshot: Pick<HospitalReportDefinition, "name" | "metricCode" | "metricDefinitionVersion" | "filters" | "format" | "version">;
  status: "PENDING" | "SUCCEEDED" | "FAILED"; attempts: number; rowCount?: number;
  errorCode?: string; generatedAt?: string; version: number; createdAt: string; updatedAt: string;
}
export interface HospitalReportJobView { job: HospitalReportJob; downloadAvailable: boolean }
export interface HospitalReportArtifact {
  jobId: string; name: string; format: "CSV" | "JSONL";
  contentType: "text/csv" | "application/x-ndjson"; content: string; rowCount: number;
  generatedAt: string; definition: HospitalReportJob["definitionSnapshot"];
}
