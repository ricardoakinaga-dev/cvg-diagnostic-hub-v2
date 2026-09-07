import { describe, expect, it } from "vitest";
import type { DiagnosticService } from "../domain/models";
import {
  isSlaClockOverdue,
  legacyServiceSlaPolicy,
  pauseSlaClock,
  resumeSlaClock,
  SlaPolicyError,
  startSlaClock,
  type SlaPolicy
} from "./sla-policy";

const service: DiagnosticService = {
  id: "service-synthetic",
  code: "SYNTHETIC",
  name: "Serviço sintético",
  category: "LABORATORY",
  departmentCode: "LABORATORY",
  workflowType: "LABORATORY",
  requiresSample: true,
  requiresSchedule: false,
  allowsAttachment: false,
  active: true,
  resultSchema: "NARRATIVE",
  slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 },
  version: 7
};

function approvedPolicy(overrides: Partial<SlaPolicy> = {}): SlaPolicy {
  return {
    id: "sla-laboratory-synthetic",
    version: 3,
    source: "CONFIGURED_POLICY",
    durationMs: 2 * 60 * 60 * 1000,
    startEvent: "REQUESTED",
    pauseMode: "EXCLUDE_PAUSED_TIME",
    calendar: { kind: "CONTINUOUS" },
    approval: {
      status: "APPROVED",
      reference: "synthetic-approval-ref",
      approvedAt: "2026-09-01T12:00:00.000Z"
    },
    ...overrides
  };
}

describe("SLA policy clock", () => {
  it("keeps the current service SLA as an explicit, narrow legacy fallback", () => {
    const policy = legacyServiceSlaPolicy(service, "URGENT");
    const clock = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T12:00:00.000Z" });

    expect(policy).toMatchObject({
      id: "legacy-service:service-synthetic:URGENT",
      version: 7,
      source: "LEGACY_SERVICE_FALLBACK",
      startEvent: "REQUESTED",
      pauseMode: "DISALLOWED",
      calendar: { kind: "CONTINUOUS" },
      approval: { status: "LEGACY_FALLBACK", reason: "D04_NOT_APPROVED" }
    });
    expect(clock).toMatchObject({
      policyVersion: 7,
      policySource: "LEGACY_SERVICE_FALLBACK",
      startedAt: "2026-09-04T12:00:00.000Z",
      dueAt: "2026-09-04T16:00:00.000Z",
      status: "RUNNING"
    });
    expect(() => pauseSlaClock(clock, policy, "2026-09-04T13:00:00.000Z", "Aguardando insumo"))
      .toThrowError(expect.objectContaining({ code: "SLA_PAUSE_NOT_ALLOWED" }));
    expect(() => resumeSlaClock({
      ...clock,
      status: "PAUSED",
      pauses: [{ startedAt: "2026-09-04T13:00:00.000Z", reason: "Estado legado inválido" }]
    }, policy, "2026-09-04T14:00:00.000Z"))
      .toThrowError(expect.objectContaining({ code: "SLA_PAUSE_NOT_ALLOWED" }));
  });

  it("preserves fractional service hours accepted by the existing catalog contract", () => {
    const policy = legacyServiceSlaPolicy({
      ...service,
      slaHours: { ...service.slaHours, URGENT: 0.25 }
    }, "URGENT");
    const clock = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T12:00:00.000Z" });

    expect(clock.dueAt).toBe("2026-09-04T12:15:00.000Z");
  });

  it("fails closed for configured policy without approval", () => {
    const policy = approvedPolicy({ approval: { status: "PENDING" } });
    expect(() => startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T12:00:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "SLA_POLICY_NOT_APPROVED" }));
  });

  it("uses materialized calendar windows without inventing weekend or timezone rules", () => {
    const policy = approvedPolicy({
      calendar: {
        kind: "EXPLICIT_WINDOWS",
        timezone: "America/Sao_Paulo",
        windows: [
          { startsAt: "2026-09-04T12:00:00.000Z", endsAt: "2026-09-04T20:00:00.000Z" },
          { startsAt: "2026-09-07T12:00:00.000Z", endsAt: "2026-09-07T20:00:00.000Z" }
        ]
      }
    });
    const clock = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T19:00:00.000Z" });

    expect(clock.dueAt).toBe("2026-09-07T13:00:00.000Z");
  });

  it("fails closed when the approved calendar cannot cover the duration", () => {
    const policy = approvedPolicy({
      calendar: {
        kind: "EXPLICIT_WINDOWS",
        timezone: "UTC",
        windows: [{ startsAt: "2026-09-04T12:00:00.000Z", endsAt: "2026-09-04T13:00:00.000Z" }]
      }
    });
    expect(() => startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T12:00:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "SLA_CALENDAR_EXHAUSTED" }));
  });

  it("pauses and resumes with the same policy version and derives overdue without changing clinical state", () => {
    const policy = approvedPolicy({ durationMs: 4 * 60 * 60 * 1000 });
    const started = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" });
    const paused = pauseSlaClock(started, policy, "2026-09-04T10:00:00.000Z", "Dependência externa sintética");

    expect(paused).toMatchObject({ status: "PAUSED", activeElapsedMs: 60 * 60 * 1000 });
    expect(isSlaClockOverdue(paused, "2026-09-05T20:00:00.000Z")).toBe(false);

    const resumed = resumeSlaClock(paused, policy, "2026-09-04T12:00:00.000Z");
    expect(resumed).toMatchObject({
      status: "RUNNING",
      dueAt: "2026-09-04T15:00:00.000Z",
      activeElapsedMs: 60 * 60 * 1000,
      accumulatedPausedMs: 2 * 60 * 60 * 1000
    });
    expect(resumed.pauses).toEqual([{
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T12:00:00.000Z",
      reason: "Dependência externa sintética"
    }]);
    expect(isSlaClockOverdue(resumed, "2026-09-04T15:00:00.000Z")).toBe(false);
    expect(isSlaClockOverdue(resumed, "2026-09-04T15:00:00.001Z")).toBe(true);
  });

  it("binds start event and later transitions to the policy version that opened the clock", () => {
    const policy = approvedPolicy({ startEvent: "RECEIVED" });
    expect(() => startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "SLA_START_EVENT_MISMATCH" }));

    const started = startSlaClock(policy, { type: "RECEIVED", occurredAt: "2026-09-04T09:00:00.000Z" });
    expect(() => pauseSlaClock(started, { ...policy, version: 4 }, "2026-09-04T10:00:00.000Z", "Teste"))
      .toThrowError(expect.objectContaining({ code: "SLA_POLICY_VERSION_MISMATCH" }));
  });

  it("rejects malformed or overlapping policy windows", () => {
    const policy = approvedPolicy({
      calendar: {
        kind: "EXPLICIT_WINDOWS",
        timezone: "UTC",
        windows: [
          { startsAt: "2026-09-04T09:00:00.000Z", endsAt: "2026-09-04T12:00:00.000Z" },
          { startsAt: "2026-09-04T11:00:00.000Z", endsAt: "2026-09-04T13:00:00.000Z" }
        ]
      }
    });
    expect(() => startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" }))
      .toThrowError(SlaPolicyError);
  });

  it("rejects invalid policy identity, version, duration and approval provenance", () => {
    const invalidPolicies: SlaPolicy[] = [
      approvedPolicy({ id: " " }),
      approvedPolicy({ version: 0 }),
      approvedPolicy({ durationMs: 0 }),
      approvedPolicy({ durationMs: Number.POSITIVE_INFINITY }),
      approvedPolicy({ approval: { status: "APPROVED", reference: " ", approvedAt: "2026-09-01T12:00:00.000Z" } }),
      approvedPolicy({ approval: { status: "APPROVED", reference: "ref", approvedAt: "not-a-date" } })
    ];

    for (const policy of invalidPolicies) {
      expect(() => startSlaClock(policy, { type: policy.startEvent, occurredAt: "2026-09-04T09:00:00.000Z" }))
        .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
    }
  });

  it("does not let a legacy fallback acquire configured-policy capabilities", () => {
    const fallback = legacyServiceSlaPolicy(service, "URGENT");
    const explicitCalendar = {
      kind: "EXPLICIT_WINDOWS" as const,
      timezone: "UTC",
      windows: [{ startsAt: "2026-09-04T09:00:00.000Z", endsAt: "2026-09-04T17:00:00.000Z" }]
    };
    const invalidFallbacks: SlaPolicy[] = [
      { ...fallback, approval: { status: "PENDING" } },
      { ...fallback, calendar: explicitCalendar },
      { ...fallback, pauseMode: "EXCLUDE_PAUSED_TIME" },
      { ...fallback, startEvent: "RECEIVED" }
    ];

    for (const policy of invalidFallbacks) {
      expect(() => startSlaClock(policy, { type: policy.startEvent, occurredAt: "2026-09-04T09:00:00.000Z" }))
        .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
    }
  });

  it("rejects invalid calendar timezone, empty windows, timestamps and reversed windows", () => {
    const calendars: SlaPolicy["calendar"][] = [
      { kind: "EXPLICIT_WINDOWS", timezone: "Invalid/Timezone", windows: [{ startsAt: "2026-09-04T09:00:00.000Z", endsAt: "2026-09-04T17:00:00.000Z" }] },
      { kind: "EXPLICIT_WINDOWS", timezone: "UTC", windows: [] },
      { kind: "EXPLICIT_WINDOWS", timezone: "UTC", windows: [{ startsAt: "invalid", endsAt: "2026-09-04T17:00:00.000Z" }] },
      { kind: "EXPLICIT_WINDOWS", timezone: "UTC", windows: [{ startsAt: "2026-09-04T17:00:00.000Z", endsAt: "2026-09-04T09:00:00.000Z" }] }
    ];

    for (const calendar of calendars) {
      expect(() => startSlaClock(approvedPolicy({ calendar }), { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" }))
        .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
    }
  });

  it("rejects invalid clock transitions and pause reasons", () => {
    const policy = approvedPolicy();
    const running = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" });
    expect(() => resumeSlaClock(running, policy, "2026-09-04T10:00:00.000Z"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));
    expect(() => pauseSlaClock(running, policy, "2026-09-04T10:00:00.000Z", " "))
      .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
    expect(() => pauseSlaClock(running, policy, "2026-09-04T08:59:59.000Z", "Teste"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));

    const paused = pauseSlaClock(running, policy, "2026-09-04T10:00:00.000Z", "Teste");
    expect(() => pauseSlaClock(paused, policy, "2026-09-04T11:00:00.000Z", "Teste"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));
    expect(() => resumeSlaClock(paused, policy, "2026-09-04T09:59:59.000Z"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));
    expect(() => resumeSlaClock({ ...paused, pauses: [] }, policy, "2026-09-04T11:00:00.000Z"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));
    expect(() => resumeSlaClock({ ...paused, pauses: [{ ...paused.pauses[0], endedAt: "2026-09-04T10:30:00.000Z" }] }, policy, "2026-09-04T11:00:00.000Z"))
      .toThrowError(expect.objectContaining({ code: "SLA_CLOCK_STATE_INVALID" }));
  });

  it("keeps multiple pause intervals and calendar-only active time deterministic", () => {
    const policy = approvedPolicy({
      durationMs: 4 * 60 * 60 * 1000,
      calendar: {
        kind: "EXPLICIT_WINDOWS",
        timezone: "UTC",
        windows: [
          { startsAt: "2026-09-04T06:00:00.000Z", endsAt: "2026-09-04T08:00:00.000Z" },
          { startsAt: "2026-09-04T09:00:00.000Z", endsAt: "2026-09-04T18:00:00.000Z" }
        ]
      }
    });
    const started = startSlaClock(policy, { type: "REQUESTED", occurredAt: "2026-09-04T08:30:00.000Z" });
    const firstPause = pauseSlaClock(started, policy, "2026-09-04T10:00:00.000Z", "Primeira pausa");
    const firstResume = resumeSlaClock(firstPause, policy, "2026-09-04T11:00:00.000Z");
    const secondPause = pauseSlaClock(firstResume, policy, "2026-09-04T12:00:00.000Z", "Segunda pausa");
    const secondResume = resumeSlaClock(secondPause, policy, "2026-09-04T13:00:00.000Z");

    expect(secondResume).toMatchObject({
      activeElapsedMs: 2 * 60 * 60 * 1000,
      accumulatedPausedMs: 2 * 60 * 60 * 1000,
      dueAt: "2026-09-04T15:00:00.000Z"
    });
    expect(secondResume.pauses).toHaveLength(2);
    expect(secondResume.pauses.every((pause) => pause.endedAt !== undefined)).toBe(true);
  });

  it("rejects an invalid legacy service duration and malformed observation timestamps", () => {
    expect(() => legacyServiceSlaPolicy({ ...service, slaHours: { ...service.slaHours, URGENT: 0 } }, "URGENT"))
      .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
    const clock = startSlaClock(approvedPolicy(), { type: "REQUESTED", occurredAt: "2026-09-04T09:00:00.000Z" });
    expect(() => isSlaClockOverdue(clock, "invalid"))
      .toThrowError(expect.objectContaining({ code: "SLA_POLICY_INVALID" }));
  });
});
