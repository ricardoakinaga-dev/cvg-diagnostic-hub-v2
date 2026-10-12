export const PRIORITIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const WORKFLOW_TYPES = ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const LABORATORY_VALUE_TYPES = ["NUMERIC", "QUALITATIVE", "TEXT"] as const;
export type LaboratoryValueType = (typeof LABORATORY_VALUE_TYPES)[number];

export const LABORATORY_PANEL_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export type LaboratoryPanelStatus = (typeof LABORATORY_PANEL_STATUSES)[number];

export const LABORATORY_REFERENCE_RANGE_KINDS = ["NUMERIC", "PENDING_POLICY"] as const;
export type LaboratoryReferenceRangeKind = (typeof LABORATORY_REFERENCE_RANGE_KINDS)[number];

export const LABORATORY_REFERENCE_RANGE_SOURCES = ["HUMAN_APPROVED", "SYNTHETIC_FIXTURE", "PENDING_HUMAN_POLICY"] as const;
export type LaboratoryReferenceRangeSource = (typeof LABORATORY_REFERENCE_RANGE_SOURCES)[number];

export const LABORATORY_FLAGS = ["NORMAL", "LOW", "HIGH", "UNINTERPRETED"] as const;
export type LaboratoryFlag = (typeof LABORATORY_FLAGS)[number];

export interface LaboratoryReferenceRange {
  kind: LaboratoryReferenceRangeKind;
  unitCode: string;
  low?: number;
  high?: number;
  source: LaboratoryReferenceRangeSource;
  note?: string;
}

export interface LaboratoryAnalyteDefinition {
  code: string;
  label: string;
  valueType: LaboratoryValueType;
  unitCode: string;
  required: boolean;
  displayOrder: number;
  referenceRange?: LaboratoryReferenceRange;
  allowedValues?: string[];
}

/** Versioned panel definition. Thresholds are configuration, never inferred by the UI. */
export interface LaboratoryPanelTemplate {
  kind: "LABORATORY_PANEL";
  code: string;
  name: string;
  version: number;
  schemaVersion: string;
  status: LaboratoryPanelStatus;
  analytes: LaboratoryAnalyteDefinition[];
  approval?: LaboratoryTemplateApproval;
}

export interface LaboratoryReferencePopulation {
  species: string[];
  sex?: string[];
  minAgeDays?: number;
  maxAgeDays?: number;
}

/** Written only by the authorized clinical publication command, never trusted from catalog input. */
export interface LaboratoryTemplateApproval {
  approvedBy: string;
  approvedAt: string;
  policyReference: string;
  population: LaboratoryReferencePopulation;
}

export interface LaboratoryObservation {
  analyteCode: string;
  value: number | string;
  unitCode: string;
  flag: LaboratoryFlag;
  referenceRange: LaboratoryReferenceRange | null;
}

export interface StructuredLaboratoryResultContent {
  kind: "LABORATORY_STRUCTURED";
  panelCode: string;
  panelVersion: number;
  observations: LaboratoryObservation[];
}

export interface DiagnosticService {
  id: string;
  code: string;
  name: string;
  category: "LABORATORY" | "IMAGING";
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  sampleType?: string;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: "NUMERIC_PANEL" | "NARRATIVE";
  resultTemplate?: LaboratoryPanelTemplate;
  active: boolean;
  version: number;
  slaHours: Record<Priority, number>;
}
