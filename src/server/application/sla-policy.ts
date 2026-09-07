import type { Priority } from "@cvg/contracts";
import type { DiagnosticService } from "../domain/models";

const HOUR_MS = 60 * 60 * 1000;

export type SlaStartEvent = "REQUESTED" | "RECEIVED" | "PROCESSING_STARTED";
export type SlaPauseMode = "DISALLOWED" | "EXCLUDE_PAUSED_TIME";

export interface SlaCalendarWindow {
  startsAt: string;
  endsAt: string;
}

export type SlaCalendar =
  | { kind: "CONTINUOUS" }
  | {
      /**
       * The timezone identifies the approved source calendar. Windows are
       * materialized as absolute instants so DST and local-time ambiguity are
       * resolved before this deterministic calculation boundary.
       */
      kind: "EXPLICIT_WINDOWS";
      timezone: string;
      windows: readonly SlaCalendarWindow[];
    };

export type SlaPolicyApproval =
  | { status: "PENDING" }
  | { status: "APPROVED"; reference: string; approvedAt: string }
  | {
      status: "LEGACY_FALLBACK";
      reason: "D04_NOT_APPROVED";
    };

export interface SlaPolicy {
  id: string;
  version: number;
  source: "CONFIGURED_POLICY" | "LEGACY_SERVICE_FALLBACK";
  durationMs: number;
  startEvent: SlaStartEvent;
  pauseMode: SlaPauseMode;
  calendar: SlaCalendar;
  approval: SlaPolicyApproval;
}

export interface SlaPauseInterval {
  startedAt: string;
  endedAt?: string;
  reason: string;
}

export interface SlaClock {
  policyId: string;
  policyVersion: number;
  policySource: SlaPolicy["source"];
  startEvent: SlaStartEvent;
  startedAt: string;
  dueAt: string;
  status: "RUNNING" | "PAUSED";
  activeElapsedMs: number;
  accumulatedPausedMs: number;
  lastResumedAt: string;
  pauses: readonly SlaPauseInterval[];
}

export type SlaPolicyErrorCode =
  | "SLA_POLICY_INVALID"
  | "SLA_POLICY_NOT_APPROVED"
  | "SLA_POLICY_VERSION_MISMATCH"
  | "SLA_START_EVENT_MISMATCH"
  | "SLA_CALENDAR_EXHAUSTED"
  | "SLA_PAUSE_NOT_ALLOWED"
  | "SLA_CLOCK_STATE_INVALID";

export class SlaPolicyError extends Error {
  constructor(
    public readonly code: SlaPolicyErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SlaPolicyError";
  }
}

interface ParsedWindow {
  startsAt: number;
  endsAt: number;
}

function invalid(message: string): never {
  throw new SlaPolicyError("SLA_POLICY_INVALID", message);
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(`${field} deve ser um timestamp válido.`);
  return parsed;
}

function policyIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) invalid(`${field} deve conter entre 1 e 200 caracteres.`);
  return normalized;
}

function parsedWindows(calendar: Extract<SlaCalendar, { kind: "EXPLICIT_WINDOWS" }>): ParsedWindow[] {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: calendar.timezone }).format();
  } catch {
    invalid("calendar.timezone deve ser um fuso IANA válido.");
  }
  if (calendar.windows.length === 0) invalid("Um calendário explícito deve conter ao menos uma janela.");

  const windows = calendar.windows
    .map((window, index) => {
      const startsAt = timestamp(window.startsAt, `calendar.windows[${index}].startsAt`);
      const endsAt = timestamp(window.endsAt, `calendar.windows[${index}].endsAt`);
      if (endsAt <= startsAt) invalid(`calendar.windows[${index}] deve terminar depois de começar.`);
      return { startsAt, endsAt };
    })
    .sort((left, right) => left.startsAt - right.startsAt || left.endsAt - right.endsAt);

  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].startsAt < windows[index - 1].endsAt) {
      invalid("As janelas do calendário não podem se sobrepor.");
    }
  }
  return windows;
}

function validatePolicy(policy: SlaPolicy): void {
  policyIdentity(policy.id, "policy.id");
  if (!Number.isInteger(policy.version) || policy.version < 1) invalid("policy.version deve ser um inteiro positivo.");
  if (!Number.isFinite(policy.durationMs) || policy.durationMs <= 0 || policy.durationMs > Number.MAX_SAFE_INTEGER) {
    invalid("policy.durationMs deve ser uma duração positiva e segura.");
  }

  if (policy.source === "LEGACY_SERVICE_FALLBACK") {
    if (
      policy.approval.status !== "LEGACY_FALLBACK"
      || policy.calendar.kind !== "CONTINUOUS"
      || policy.pauseMode !== "DISALLOWED"
      || policy.startEvent !== "REQUESTED"
    ) {
      invalid("O fallback legado aceita apenas relógio contínuo iniciado na solicitação e sem pausa.");
    }
  } else {
    if (policy.approval.status !== "APPROVED") {
      throw new SlaPolicyError(
        "SLA_POLICY_NOT_APPROVED",
        "A política de SLA configurada não possui aprovação vigente."
      );
    }
    policyIdentity(policy.approval.reference, "policy.approval.reference");
    timestamp(policy.approval.approvedAt, "policy.approval.approvedAt");
  }

  if (policy.calendar.kind === "EXPLICIT_WINDOWS") parsedWindows(policy.calendar);
}

function addEligibleDuration(calendar: SlaCalendar, from: number, durationMs: number): number {
  if (durationMs === 0) return from;
  if (calendar.kind === "CONTINUOUS") return from + durationMs;

  let remaining = durationMs;
  for (const window of parsedWindows(calendar)) {
    if (window.endsAt <= from) continue;
    const eligibleStart = Math.max(from, window.startsAt);
    const available = window.endsAt - eligibleStart;
    if (remaining <= available) return eligibleStart + remaining;
    remaining -= available;
  }
  throw new SlaPolicyError(
    "SLA_CALENDAR_EXHAUSTED",
    "O calendário aprovado não possui janelas suficientes para calcular o vencimento."
  );
}

function eligibleDuration(calendar: SlaCalendar, from: number, to: number): number {
  if (to < from) {
    throw new SlaPolicyError("SLA_CLOCK_STATE_INVALID", "O relógio de SLA não pode retroceder no tempo.");
  }
  if (calendar.kind === "CONTINUOUS") return to - from;
  return parsedWindows(calendar).reduce((total, window) => {
    const startsAt = Math.max(from, window.startsAt);
    const endsAt = Math.min(to, window.endsAt);
    return total + Math.max(0, endsAt - startsAt);
  }, 0);
}

function assertPolicyBinding(clock: SlaClock, policy: SlaPolicy): void {
  validatePolicy(policy);
  if (
    clock.policyId !== policy.id
    || clock.policyVersion !== policy.version
    || clock.policySource !== policy.source
  ) {
    throw new SlaPolicyError(
      "SLA_POLICY_VERSION_MISMATCH",
      "O relógio deve continuar usando a mesma política e versão com que foi iniciado."
    );
  }
}

/**
 * Compatibility policy for the existing service.slaHours contract. This is
 * deliberately narrow and visibly unapproved: request time, 24x7 calendar,
 * no pause. Any richer configured policy must pass the approval guard.
 */
export function legacyServiceSlaPolicy(service: DiagnosticService, priority: Priority): SlaPolicy {
  const hours = service.slaHours[priority];
  if (!Number.isFinite(hours) || hours <= 0 || hours * HOUR_MS > Number.MAX_SAFE_INTEGER) {
    invalid(`service.slaHours.${priority} deve produzir uma duração positiva e segura.`);
  }
  return {
    id: `legacy-service:${service.id}:${priority}`,
    version: service.version,
    source: "LEGACY_SERVICE_FALLBACK",
    durationMs: hours * HOUR_MS,
    startEvent: "REQUESTED",
    pauseMode: "DISALLOWED",
    calendar: { kind: "CONTINUOUS" },
    approval: { status: "LEGACY_FALLBACK", reason: "D04_NOT_APPROVED" }
  };
}

export function startSlaClock(
  policy: SlaPolicy,
  event: { type: SlaStartEvent; occurredAt: string }
): SlaClock {
  validatePolicy(policy);
  if (event.type !== policy.startEvent) {
    throw new SlaPolicyError(
      "SLA_START_EVENT_MISMATCH",
      `A política ${policy.id}@${policy.version} inicia em ${policy.startEvent}, não em ${event.type}.`
    );
  }
  const startedAt = timestamp(event.occurredAt, "event.occurredAt");
  const dueAt = addEligibleDuration(policy.calendar, startedAt, policy.durationMs);
  const normalizedStartedAt = new Date(startedAt).toISOString();
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    policySource: policy.source,
    startEvent: policy.startEvent,
    startedAt: normalizedStartedAt,
    dueAt: new Date(dueAt).toISOString(),
    status: "RUNNING",
    activeElapsedMs: 0,
    accumulatedPausedMs: 0,
    lastResumedAt: normalizedStartedAt,
    pauses: []
  };
}

export function pauseSlaClock(
  clock: SlaClock,
  policy: SlaPolicy,
  at: string,
  reason: string
): SlaClock {
  assertPolicyBinding(clock, policy);
  if (policy.pauseMode !== "EXCLUDE_PAUSED_TIME") {
    throw new SlaPolicyError("SLA_PAUSE_NOT_ALLOWED", "A política aplicada não autoriza pausa do SLA.");
  }
  if (clock.status !== "RUNNING") {
    throw new SlaPolicyError("SLA_CLOCK_STATE_INVALID", "Somente um relógio em execução pode ser pausado.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason.length > 500) invalid("O motivo da pausa deve conter entre 1 e 500 caracteres.");
  const pausedAt = timestamp(at, "pause.at");
  const lastResumedAt = timestamp(clock.lastResumedAt, "clock.lastResumedAt");
  const activeElapsedMs = Math.min(
    policy.durationMs,
    clock.activeElapsedMs + eligibleDuration(policy.calendar, lastResumedAt, pausedAt)
  );
  return {
    ...clock,
    status: "PAUSED",
    activeElapsedMs,
    pauses: [...clock.pauses, { startedAt: new Date(pausedAt).toISOString(), reason: normalizedReason }]
  };
}

export function resumeSlaClock(clock: SlaClock, policy: SlaPolicy, at: string): SlaClock {
  assertPolicyBinding(clock, policy);
  if (policy.pauseMode !== "EXCLUDE_PAUSED_TIME") {
    throw new SlaPolicyError("SLA_PAUSE_NOT_ALLOWED", "A política aplicada não autoriza retomada após pausa.");
  }
  if (clock.status !== "PAUSED") {
    throw new SlaPolicyError("SLA_CLOCK_STATE_INVALID", "Somente um relógio pausado pode ser retomado.");
  }
  const currentPause = clock.pauses.at(-1);
  if (!currentPause || currentPause.endedAt) {
    throw new SlaPolicyError("SLA_CLOCK_STATE_INVALID", "O relógio pausado deve possuir uma pausa aberta.");
  }
  const resumedAt = timestamp(at, "resume.at");
  const pausedAt = timestamp(currentPause.startedAt, "clock.pause.startedAt");
  if (resumedAt < pausedAt) {
    throw new SlaPolicyError("SLA_CLOCK_STATE_INVALID", "A retomada não pode ocorrer antes da pausa.");
  }
  const remainingMs = Math.max(0, policy.durationMs - clock.activeElapsedMs);
  const normalizedResumedAt = new Date(resumedAt).toISOString();
  return {
    ...clock,
    status: "RUNNING",
    dueAt: new Date(addEligibleDuration(policy.calendar, resumedAt, remainingMs)).toISOString(),
    accumulatedPausedMs: clock.accumulatedPausedMs + resumedAt - pausedAt,
    lastResumedAt: normalizedResumedAt,
    pauses: clock.pauses.map((pause, index) => index === clock.pauses.length - 1
      ? { ...pause, endedAt: normalizedResumedAt }
      : pause)
  };
}

export function isSlaClockOverdue(clock: SlaClock, asOf: string): boolean {
  const observedAt = timestamp(asOf, "asOf");
  const dueAt = timestamp(clock.dueAt, "clock.dueAt");
  return clock.status === "RUNNING" && observedAt > dueAt;
}
