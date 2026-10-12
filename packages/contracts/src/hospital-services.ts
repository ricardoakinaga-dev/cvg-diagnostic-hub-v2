export const HOSPITAL_SERVICE_KINDS = ["CARE", "PROCEDURE", "OPERATIONAL"] as const;
export type HospitalServiceKind = (typeof HOSPITAL_SERVICE_KINDS)[number];
export type HospitalServiceCatalogKind = HospitalServiceKind | "DIAGNOSTIC";

/** Descriptive capability; membership never supplies clinical grants. */
export interface HospitalService {
  id: string;
  code: string;
  name: string;
  description?: string;
  kind: HospitalServiceKind;
  departmentCode: string;
  teamUserIds: string[];
  resourceIds: string[];
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type HospitalServiceCatalogEntry = (HospitalService & { source: "HOSPITAL_SERVICE" }) | {
  source: "DIAGNOSTIC_SERVICE";
  id: string;
  code: string;
  name: string;
  kind: "DIAGNOSTIC";
  departmentCode: string;
  teamUserIds: string[];
  resourceIds: string[];
  active: boolean;
  version: number;
};

/** Written when an activity binds the definition; later catalog writes never replace it. */
export interface HospitalServiceSnapshot {
  source: HospitalServiceCatalogEntry["source"];
  serviceId: string;
  serviceVersion: number;
  code: string;
  name: string;
  kind: HospitalServiceCatalogKind;
  departmentCode: string;
  teamUserIds: string[];
  resourceIds: string[];
  capturedAt: string;
}

export interface HospitalServiceImportReport {
  applied: boolean;
  dryRun: boolean;
  rows: Array<{ line: number; code: string; action: "CREATE" | "UPDATE" | "UNCHANGED" | "ERROR"; errors?: string[] }>;
  summary: { create: number; update: number; unchanged: number; error: number };
}

export interface HospitalServicePage { items: HospitalServiceCatalogEntry[]; total: number; nextCursor?: string }
