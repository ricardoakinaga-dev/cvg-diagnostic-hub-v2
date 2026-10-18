import type { Permission } from "./identity-permissions";

export interface HospitalDocumentInline {
  text: string;
  marks?: Array<"strong" | "emphasis">;
  href?: string;
}
export type HospitalDocumentBlock =
  | { type: "paragraph" | "quote"; content: HospitalDocumentInline[] }
  | { type: "heading"; level: 1 | 2 | 3; content: HospitalDocumentInline[] }
  | { type: "list"; ordered: boolean; items: HospitalDocumentInline[][] }
  | { type: "table"; rows: HospitalDocumentInline[][][]; header: boolean }
  | { type: "code"; text: string };
/** Structured content only. Render text as text nodes, never as HTML. */
export interface HospitalDocumentContent {
  type: "hospital-document";
  version: 1;
  blocks: HospitalDocumentBlock[];
}
export interface HospitalDocumentRevision {
  id: string;
  revision: number;
  title: string;
  content: HospitalDocumentContent;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  policyReference?: string;
  retiredBy?: string;
  retiredAt?: string;
  retirementReason?: string;
}
/** Publication changes the current pointer; approved revision content is immutable. */
export interface HospitalDocument {
  id: string;
  code: string;
  title: string;
  departmentCode: string;
  responsibleUserId: string;
  locked: boolean;
  archived: boolean;
  currentPublishedRevisionId?: string;
  draftRevisionId?: string;
  revisions: HospitalDocumentRevision[];
  sourceDocumentId?: string;
  sourceRevisionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface HospitalDocumentSnapshot {
  documentId: string;
  code: string;
  title: string;
  departmentCode: string;
  revisionId: string;
  revision: number;
  content: HospitalDocumentContent;
  approvedBy: string;
  approvedAt: string;
  policyReference: string;
  capturedAt: string;
}
export interface HospitalDocumentView {
  document: HospitalDocument;
  permissions: Permission[];
  favorite: boolean;
}
export interface HospitalDocumentSummary {
  id: string;
  code: string;
  title: string;
  departmentCode: string;
  responsibleUserId: string;
  locked: boolean;
  archived: boolean;
  currentRevision?: number;
  currentStatus?: "APPROVED" | "RETIRED";
  hasDraft: boolean;
  favorite: boolean;
  version: number;
  updatedAt: string;
}
export interface HospitalDocumentFilters {
  departmentCode?: string;
  query?: string;
  includeArchived?: boolean;
  favoritesOnly?: boolean;
  limit?: number;
  cursor?: string;
}
export interface HospitalDocumentPage {
  items: HospitalDocumentSummary[];
  total: number;
  limit: number;
  nextCursor?: string;
}
export interface HospitalDocumentOptions {
  departments: Array<{ code: string; name: string }>;
  responsibles: Array<{ id: string; displayName: string; departmentCode: string }>;
}
