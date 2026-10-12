import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import type { AuditEvent } from "../domain/models";

async function context() {
  const store = new MemoryStore(createDemoState("timeline-test-password"));
  const service = createApplicationService(store);
  const vet = store.getState().users.find((user) => user.email === "vet@cvg.local")!;
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "timeline-request" });
  const events: AuditEvent[] = Array.from({ length: 123 }, (_, index) => ({ id: `history-${String(index).padStart(3, "0")}`, eventType: "DiagnosticItemRequested", actorId: vet.id, entityType: "DiagnosticRequestItem", entityId: request.items[0].id, correlationId: `corr-${index}`, occurredAt: "2026-10-11T12:00:00.000Z", metadata: {} }));
  await store.transaction((state) => ({ state: { ...state, auditEvents: events }, result: undefined }));
  return { store, service, vet };
}

describe("paged patient timeline", () => {
  it("returns every event once across tied timestamps and binds cursors to the patient", async () => {
    const c = await context();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.service.getPatientTimeline(c.vet, "patient-thor", { limit: 20, cursor });
      expect(page.total).toBe(123);
      ids.push(...page.items.map((event) => event.id));
      cursor = page.nextCursor;
      if (cursor) await expect(c.service.getPatientTimeline(c.vet, "patient-mel", { cursor })).rejects.toMatchObject({ status: 400 });
    } while (cursor);
    expect(ids).toHaveLength(123);
    expect(new Set(ids).size).toBe(123);
    const workspace = await c.service.getPatientDiagnostics(c.vet, "patient-thor", { timelineLimit: 50 });
    expect(workspace.events).toHaveLength(50);
    expect(workspace.timelineTotal).toBe(123);
    expect(workspace.timelineNextCursor).toBeDefined();
  });
  it("refuses unknown/forbidden patients and invalid cursor/limit without reading history", async () => {
    const c = await context();
    const read = vi.spyOn(c.store, "readAuditEvents");
    await expect(c.service.getPatientTimeline(c.vet, "patient-missing")).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getPatientTimeline(c.vet, "patient-thor", { cursor: "invalid" })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.getPatientTimeline(c.vet, "patient-thor", { limit: 0 })).rejects.toMatchObject({ status: 400 });
    expect(read).not.toHaveBeenCalled();
  });
  it("revalidates revocation after asynchronous historical I/O", async () => {
    const c = await context();
    const original = c.store.readAuditEvents.bind(c.store);
    vi.spyOn(c.store, "readAuditEvents").mockImplementationOnce(async (query) => {
      const page = await original(query);
      await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.vet.id ? { ...user, patientIds: [], version: user.version + 1 } : user) }, result: undefined }));
      return page;
    });
    await expect(c.service.getPatientTimeline(c.vet, "patient-thor", { limit: 20 })).rejects.toMatchObject({ status: 404 });
  });
});
