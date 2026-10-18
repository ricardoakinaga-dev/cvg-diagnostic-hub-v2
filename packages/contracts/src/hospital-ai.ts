import type { HospitalDocumentContent } from "./hospital-documents";
export interface HospitalAiSuggestion {
  id: string;
  documentId: string;
  draftRevisionId: string;
  sourceDocumentVersion: number;
  sourceDraftVersion: number;
  sourceContentHash: string;
  requestedBy: string;
  createdAt: string;
  provider: string;
  model: string;
  remoteReceiptId: string;
  content: HospitalDocumentContent;
  status: "PENDING_REVIEW" | "APPLIED" | "REJECTED";
  reviewedBy?: string;
  reviewedAt?: string;
  reviewReason?: string;
  appliedDocumentVersion?: number;
  version: number;
}
export interface HospitalAiCapability {
  configured: boolean;
  purpose: "OPERATIONAL_DOCUMENT_TEXT";
  provider?: string;
  model?: string;
  decisionReference?: string;
  deploymentVerified: false;
  requiresHumanReview: true;
  reason?: "CONFIGURATION_MISSING" | "CONFIGURATION_INVALID";
}
