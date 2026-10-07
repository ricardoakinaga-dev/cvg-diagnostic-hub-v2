import { describe, expect, it } from "vitest";
import type { StoreState } from "../domain/models";
import { createDemoState } from "./fixtures";
import {
  assertAuditEventsAppendOnly,
  cloneState,
  CURRENT_STATE_SQL,
  CURRENT_VERSION_SQL,
  LOCKED_STATE_SQL,
  runtimeStateFromRow,
  stateFromRow,
  versionFromRow
} from "./postgres-state-codec";

function stateWithAuditEvents(count: number): StoreState {
  const state = createDemoState("postgres-state-codec-password");
  return {
    ...state,
    auditEvents: Array.from({ length: count }, (_, index) => ({
      id: `audit-${index}`,
      eventType: "Probe",
      entityType: "RuntimeState",
      entityId: "cvg-runtime-state",
      correlationId: `corr-${index}`,
      metadata: {},
      occurredAt: new Date(Date.parse("2026-10-03T12:00:00.000Z") + index).toISOString()
    }))
  };
}

describe("runtime state codec", () => {
  it("keeps the three aggregate statements aligned", () => {
    expect(CURRENT_STATE_SQL).toBe("SELECT state, version FROM cvg_runtime_state WHERE id = 1");
    expect(CURRENT_VERSION_SQL).toBe("SELECT version FROM cvg_runtime_state WHERE id = 1");
    expect(LOCKED_STATE_SQL).toBe(`${CURRENT_STATE_SQL} FOR UPDATE`);
  });

  it("clones defensively so callers cannot mutate the cached aggregate", () => {
    const state = stateWithAuditEvents(1);
    const cloned = cloneState(state);

    cloned.auditEvents.push({ ...state.auditEvents[0]!, id: "audit-injected" });
    expect(state.auditEvents).toHaveLength(1);
  });

  it("validates the row shape before accepting it as authority", () => {
    const state = stateWithAuditEvents(1);

    expect(stateFromRow(state).auditEvents).toHaveLength(1);
    expect(() => stateFromRow(null)).toThrow("PostgreSQL runtime state is invalid.");
    expect(() => stateFromRow([state])).toThrow("PostgreSQL runtime state is invalid.");
    expect(() => stateFromRow("{}")).toThrow("PostgreSQL runtime state is invalid.");
    expect(() => stateFromRow({ ...state, protocolSequence: -1 })).toThrow("protocol sequence is invalid");
    expect(() => stateFromRow({ ...state, protocolSequence: "many" })).toThrow("protocol sequence is invalid");
    expect(() => stateFromRow({ ...state, auditEvents: {} })).toThrow("collections are invalid");
    expect(() => stateFromRow({ ...state, users: null })).toThrow("collections are invalid");
  });

  it("normalizes bigint, numeric-string and numeric versions, rejecting the rest", () => {
    expect(versionFromRow(7)).toBe(7);
    expect(versionFromRow(7n)).toBe(7);
    expect(versionFromRow("7")).toBe(7);
    expect(() => versionFromRow(0)).toThrow("version is invalid");
    expect(() => versionFromRow("7.5")).toThrow("version is invalid");
    expect(() => versionFromRow(null)).toThrow("version is invalid");
    expect(() => versionFromRow(Number.NaN)).toThrow("version is invalid");
  });

  it("requires a row for both the aggregate and its version", () => {
    const state = stateWithAuditEvents(1);
    expect(runtimeStateFromRow({ state, version: 3 }).auditEvents).toHaveLength(1);
    expect(() => runtimeStateFromRow(undefined)).toThrow("row is missing");
    expect(() => runtimeStateFromRow({ state, version: 0 })).toThrow("version is invalid");
  });

  it("enforces the append-only audit prefix by position, not by membership", () => {
    const before = stateWithAuditEvents(3);
    const appended = { ...before, auditEvents: [...before.auditEvents, { ...before.auditEvents[0]!, id: "audit-new" }] };

    expect(() => assertAuditEventsAppendOnly(before, appended)).not.toThrow();

    // A reordered history is a mutation even when every id is still present.
    const reordered = { ...before, auditEvents: [before.auditEvents[1]!, before.auditEvents[0]!, before.auditEvents[2]!] };
    expect(() => assertAuditEventsAppendOnly(before, reordered)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    const rewritten = { ...before, auditEvents: before.auditEvents.map((event, index) => index === 1 ? { ...event, eventType: "Rewritten" } : event) };
    expect(() => assertAuditEventsAppendOnly(before, rewritten)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    const truncated = { ...before, auditEvents: before.auditEvents.slice(0, 2) };
    expect(() => assertAuditEventsAppendOnly(before, truncated)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    const duplicated = { ...before, auditEvents: [...before.auditEvents, before.auditEvents[0]!] };
    expect(() => assertAuditEventsAppendOnly(before, duplicated)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    const droppedPrefix = { ...before, auditEvents: [before.auditEvents[2]!] };
    expect(() => assertAuditEventsAppendOnly(before, droppedPrefix)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");
  });
});