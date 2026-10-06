import { describe, expect, it } from "vitest";
import type { QueueItem } from "@cvg/contracts";
import {
  EMPTY_FILTERS, activeFilterCount, applyFilters, departmentKey, departmentLabel, derivedNextAction, formatDateTime, formatDue, fromQueueItem, fromRequests,
  groupItems, isOverdue, mergeWorkItems, sortItems, workItemKey, workItemTitle, type RequestListEntry, type WorkItem
} from "./model";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function request(overrides: Partial<RequestListEntry> = {}): RequestListEntry {
  return {
    id: "request-1",
    requestCode: "EX-261006-0007",
    priority: "URGENT",
    createdAt: "2026-10-06T10:00:00.000Z",
    requesterId: "user-vet",
    patient: { id: "patient-1", displayName: "Fred", species: "Canino", externalId: "HIS-1", breed: "Beagle", ownerLabel: "L. Costa" },
    items: [
      { id: "item-hem", requestId: "request-1", status: "REQUESTED", priority: "URGENT", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, dueAt: "2026-10-06T11:00:00.000Z", service: { id: "s-hem", code: "HEMOGRAM", name: "Hemograma" } },
      { id: "item-crp", requestId: "request-1", status: "COMPLETED", priority: "URGENT", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 4, dueAt: "2026-10-06T11:00:00.000Z", service: { id: "s-crp", code: "CRP", name: "Proteína C reativa" } },
      { id: "item-rx", requestId: "request-1", status: "AWAITING_REPORT", priority: "URGENT", workflowType: "RADIOLOGY", departmentCode: "RADIOLOGY", version: 3, dueAt: "2026-10-07T11:00:00.000Z", requestedAt: "2026-10-06T10:05:00.000Z", service: { id: "s-rx", code: "XRAY", name: "RX de tórax" } }
    ],
    ...overrides
  };
}

function item(overrides: Partial<WorkItem>): WorkItem {
  return { ...fromRequests([request()], NOW)[0], ...overrides };
}

describe("work item model", () => {
  it("flattens scoped requests into Plane-style items with unique sector keys", () => {
    const items = fromRequests([request()], NOW);
    expect(items.map(workItemKey)).toEqual(["LAB-0007.1", "LAB-0007.2", "RX-0007"]);
    expect(items[0]).toMatchObject({ requesterId: "user-vet", overdue: true, nextAction: "Receber amostra", patient: { breed: "Beagle", ownerLabel: "L. Costa" } });
    expect(items[1]).toMatchObject({ overdue: false, nextAction: undefined });
    expect(items[2]).toMatchObject({ createdAt: "2026-10-06T10:05:00.000Z", overdue: false, nextAction: "Emitir laudo" });
    expect(workItemTitle(items[0])).toBe("Fred — Hemograma");
  });

  it("matches the backend deadline rule, including pending result review", () => {
    for (const status of ["COMPLETED", "CANCELLED", "REJECTED"] as const) {
      expect(isOverdue({ status, dueAt: "2020-01-01T00:00:00.000Z" }, NOW)).toBe(false);
    }
    for (const status of ["RESULT_AVAILABLE", "REVIEWED"] as const) {
      expect(isOverdue({ status, dueAt: "2020-01-01T00:00:00.000Z" }, NOW)).toBe(true);
    }
    expect(isOverdue({ status: "IN_PROGRESS", dueAt: "not-a-date" }, NOW)).toBe(false);
    expect(isOverdue({ status: "IN_PROGRESS", dueAt: "2020-01-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("derives a plain next action for every open state", () => {
    expect(derivedNextAction({ status: "REQUESTED", workflowType: "ULTRASOUND" })).toBe("Agendar exame");
    expect(derivedNextAction({ status: "REQUESTED", workflowType: "RADIOLOGY" })).toBe("Realizar procedimento");
    expect(derivedNextAction({ status: "IN_PROGRESS", workflowType: "RADIOLOGY" })).toBe("Concluir procedimento");
    expect(["RECEIVED", "SCHEDULED", "IN_PROGRESS", "RESULT_AVAILABLE", "REVIEWED", "RECOLLECTION_REQUIRED", "FAILED", "RESULT_VOIDED"].map((status) => derivedNextAction({ status: status as WorkItem["status"], workflowType: "LABORATORY" }))).toEqual([
      "Iniciar processamento", "Realizar procedimento", "Registrar resultado", "Revisar resultado", "Concluir exame", "Nova coleta de amostra", "Tratar pendência", "Reemitir resultado"
    ]);
    expect(derivedNextAction({ status: "CANCELLED", workflowType: "LABORATORY" })).toBeUndefined();
  });

  it("lets the queue projection override request fields without losing request context", () => {
    const base = fromRequests([request()], NOW);
    const queueItem = { id: "item-hem", requestId: "request-1", status: "RECEIVED", workflowType: "LABORATORY", priority: "URGENT", version: 2, dueAt: "2026-10-06T11:00:00.000Z", createdAt: "", requestCode: "EX-261006-0007", nextAction: "Iniciar processamento", overdue: false, patient: { id: "patient-1", displayName: "Fred", species: "Canino", externalId: "HIS-1" }, service: { id: "s-hem", code: "HEMOGRAM", name: "Hemograma" }, operationalContext: { currentOwner: { code: "DEPARTMENT", label: "Laboratório" }, nextAction: { code: "START", label: "Iniciar processamento" }, waitingSince: "2026-10-06T10:00:00.000Z", escalationLevel: "WATCH" } } as unknown as QueueItem;
    const extra = { ...queueItem, id: "item-only-queue" } as QueueItem;
    const merged = mergeWorkItems(base, [fromQueueItem(queueItem, "LABORATORY"), fromQueueItem(extra, "LABORATORY")]);
    const hem = merged.find((entry) => entry.id === "item-hem");
    expect(hem).toMatchObject({ status: "RECEIVED", version: 2, nextAction: "Iniciar processamento", requesterId: "user-vet", sectorOrdinal: 1, createdAt: "2026-10-06T10:00:00.000Z", patient: { breed: "Beagle" } });
    expect(merged.some((entry) => entry.id === "item-only-queue")).toBe(true);
  });

  it("does not replace a newer exam with an older queue snapshot", () => {
    const [base] = fromRequests([request()], NOW);
    const newer = { ...base, version: 4, status: "RESULT_AVAILABLE" as const, currentResultId: "result-new" };
    const older = { ...base, version: 3, status: "IN_PROGRESS" as const, operationalContext: { currentOwner: { label: "Stale" } } } as WorkItem;
    expect(mergeWorkItems([newer], [older])).toEqual([newer]);
  });

  it("filters by state, priority, sector, exam, deadline and accent-insensitive search", () => {
    const items = fromRequests([request(), request({ id: "request-2", requestCode: "EX-261006-0009", priority: "ROUTINE", patient: { id: "patient-2", displayName: "Lúcia", species: "Felino", externalId: "HIS-2" }, items: [{ id: "item-us", requestId: "request-2", status: "SCHEDULED", priority: "ROUTINE", workflowType: "ULTRASOUND", departmentCode: "ULTRASOUND", version: 2, dueAt: "2026-10-08T00:00:00.000Z", service: { id: "s-us", code: "US", name: "Ultrassom abdominal" } }] })], NOW);
    expect(applyFilters(items, EMPTY_FILTERS)).toHaveLength(4);
    expect(applyFilters(items, { ...EMPTY_FILTERS, search: "lucia" }).map((entry) => entry.id)).toEqual(["item-us"]);
    expect(applyFilters(items, { ...EMPTY_FILTERS, search: "rx-0007" }).map((entry) => entry.id)).toEqual(["item-rx"]);
    expect(applyFilters(items, { ...EMPTY_FILTERS, states: ["SCHEDULED"] })).toHaveLength(1);
    expect(applyFilters(items, { ...EMPTY_FILTERS, priorities: ["ROUTINE"] })).toHaveLength(1);
    expect(applyFilters(items, { ...EMPTY_FILTERS, departments: ["RADIOLOGY"] })).toHaveLength(1);
    expect(applyFilters(items, { ...EMPTY_FILTERS, services: ["HEMOGRAM"] })).toHaveLength(1);
    expect(applyFilters(items, { ...EMPTY_FILTERS, overdueOnly: true }).map((entry) => entry.id)).toEqual(["item-hem"]);
    expect(applyFilters(items, { ...EMPTY_FILTERS, hideClosed: true })).toHaveLength(3);
    expect(activeFilterCount({ ...EMPTY_FILTERS, states: ["REQUESTED", "RECEIVED"], overdueOnly: true, hideClosed: true })).toBe(4);
  });

  it("orders by deadline, priority, recency and patient", () => {
    const early = item({ id: "a", dueAt: "2026-10-06T13:00:00.000Z", priority: "ROUTINE", overdue: false, createdAt: "2026-10-01T00:00:00.000Z", patient: { id: "p", displayName: "Zeca", species: "C", externalId: "1" } });
    const late = item({ id: "b", dueAt: "2026-10-09T13:00:00.000Z", priority: "EMERGENCY", overdue: false, createdAt: "2026-10-05T00:00:00.000Z", patient: { id: "q", displayName: "Amora", species: "C", externalId: "2" } });
    const overdue = item({ id: "c", dueAt: "2026-10-10T13:00:00.000Z", priority: "URGENT", overdue: true, createdAt: "2026-10-03T00:00:00.000Z", patient: { id: "r", displayName: "Bob", species: "C", externalId: "3" } });
    expect(sortItems([late, early, overdue], "due").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(sortItems([early, overdue, late], "priority").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(sortItems([early, overdue, late], "recent").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(sortItems([early, overdue, late], "patient").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("groups by every Plane grouping option", () => {
    const items = fromRequests([request()], NOW);
    expect(groupItems(items, "status", false, { departments: [] }).map((group) => group.id)).toEqual(["REQUESTED", "AWAITING_REPORT", "COMPLETED"]);
    expect(groupItems(items, "status", true, { departments: [] })).toHaveLength(13);
    expect(groupItems(items, "priority", false, { departments: [] }).map((group) => group.label)).toEqual(["Urgente"]);
    expect(groupItems(items, "priority", true, { departments: [] })).toHaveLength(3);
    expect(groupItems(items, "department", true, { departments: ["ULTRASOUND"] }).map((group) => group.label)).toEqual(["Laboratório", "Radiologia", "Ultrassom"]);
    expect(groupItems(items, "service", false, { departments: [] }).map((group) => group.label)).toEqual(["Hemograma", "Proteína C reativa", "RX de tórax"]);
    expect(groupItems(items, "patient", false, { departments: [] })).toEqual([expect.objectContaining({ label: "Fred", kind: "patient", items: expect.any(Array) })]);
    expect(groupItems(items, "none", false, { departments: [] })[0]).toMatchObject({ kind: "all", items });
  });

  it("formats sectors and dates for the workspace", () => {
    expect(departmentLabel("ULTRASOUND")).toBe("Ultrassom");
    expect(departmentLabel("BLOOD_BANK")).toBe("Blood bank");
    expect(departmentKey("BLOOD_BANK")).toBe("BLO");
    const now = new Date(2026, 9, 6, 9, 0);
    expect(formatDue(new Date(2026, 9, 6, 14, 30).toISOString(), now)).toMatch(/^Hoje, 14:30$/);
    expect(formatDue(new Date(2026, 9, 7, 8, 5).toISOString(), now)).toMatch(/^Amanhã, 08:05$/);
    expect(formatDue(new Date(2026, 9, 20, 8, 5).toISOString(), now)).toMatch(/20/);
    expect(formatDue("nope", now)).toBe("Sem prazo");
    expect(formatDateTime(undefined)).toBe("Não informado");
    expect(formatDateTime("2026-10-06T12:00:00.000Z")).toMatch(/2026/);
  });
});
