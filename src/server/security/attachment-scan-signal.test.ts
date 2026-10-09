import { afterEach, describe, expect, it, vi } from "vitest";
import { reportAttachmentScan } from "./attachment-scan-signal";
import { renderPrometheus, resetMetrics } from "../observability/metrics";

const signal = { attachmentId: "att-1", resultVersionId: "ver-1", declaredMime: "application/pdf", detectedMime: "application/pdf", sizeBytes: 12 };

describe("attachment scan signal (PROD-308)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetMetrics();
  });

  it("counts every verdict and warns only for QUARANTINED and FAILED, without file names", () => {
    vi.stubEnv("NODE_ENV", "production");
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    resetMetrics();

    reportAttachmentScan("CLEAN", signal);
    reportAttachmentScan("QUARANTINED", signal);
    reportAttachmentScan("FAILED", { ...signal, detectedMime: "image/png" });

    const events = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.event)).toEqual(["attachment.quarantined", "attachment.scan_failed"]);
    expect(events[0]).toMatchObject({ level: "warn", component: "attachments", attachmentId: "att-1", resultVersionId: "ver-1", declaredMime: "application/pdf", sizeBytes: 12 });
    expect(events[1]).toMatchObject({ detectedMime: "image/png" });
    expect(JSON.stringify(events)).not.toContain("laudo");
    const metrics = renderPrometheus();
    expect(metrics).toContain('cvg_attachment_scans_total{status="CLEAN"} 1');
    expect(metrics).toContain('cvg_attachment_scans_total{status="QUARANTINED"} 1');
    expect(metrics).toContain('cvg_attachment_scans_total{status="FAILED"} 1');
  });
});
