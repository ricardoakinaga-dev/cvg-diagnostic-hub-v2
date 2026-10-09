import { createStructuredLogger } from "../observability/structured-logger";
import { recordAttachmentScan } from "../observability/metrics";

export interface AttachmentScanSignal {
  attachmentId: string;
  resultVersionId: string;
  declaredMime: string;
  detectedMime: string;
  sizeBytes: number;
}

/**
 * PROD-308: metric for every scanned upload and a structured warning when the verdict is not CLEAN. The object stays
 * in the bucket under its claimed key and can never be finalized or downloaded; the quarantine owner
 * (INCIDENT_RUNBOOKS.md) acts on this event. No file name, no content, no patient data.
 */
export function reportAttachmentScan(status: "CLEAN" | "QUARANTINED" | "FAILED", signal: AttachmentScanSignal): void {
  recordAttachmentScan(status);
  if (status === "CLEAN") return;
  createStructuredLogger().warn(status === "QUARANTINED" ? "attachment.quarantined" : "attachment.scan_failed", {
    component: "attachments",
    ...signal
  });
}
