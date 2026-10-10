import type { RoleCode } from "@cvg/contracts";
import type { AuditEvent, Notification, StateStore, StoreState, User } from "../domain/models";
import { findById } from "../domain/state-index";
import { canAccessResource, hasPermission } from "../security/authorization";
import { withCriticalWhatsAppAlert } from "./critical-alert-channel";
import { criticalPolicyFromEnvironment, nextCriticalRecipients, planCriticalEscalation, type CriticalEscalationDecision, type CriticalResultPolicy } from "./critical-result-policy";
import { createAudit, createOutbox, criticalResultResource, id, notificationFor, requestForNotification } from "./service-common";

export interface CriticalEscalationSummary {
  due: number;
  notified: number;
  /** Roots whose due level found nobody clinical to notify: the administrators were alerted instead (D-056). */
  unreachable: number;
}

/** Outbox event of the operational alert; its payload carries a notificationId, so it is delivered in-app. */
export const CRITICAL_UNREACHABLE_EVENT = "CriticalResultUnreachable";

export interface CriticalEscalationOptions {
  now?: Date;
  policy?: CriticalResultPolicy;
  environment?: Partial<NodeJS.ProcessEnv>;
}

/** Roles that only see the patients in their scope; the escalated professional must be able to open the result. */
const PATIENT_SCOPED_ROLES: readonly RoleCode[] = ["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"];

/**
 * AUD-02: a recipient must be able to open the result, after the patient grant below; otherwise they could
 * confirm, and stop the climb, without seeing it. A manager reaches it through the exam's department.
 */
function canOpenResult(user: User, resource: { patientId: string; departmentCode: string; serviceCode: string }): boolean {
  if (!hasPermission(user.role, "notification.acknowledge")) return false;
  const granted = PATIENT_SCOPED_ROLES.includes(user.role) ? { ...user, patientIds: [...(user.patientIds ?? []), resource.patientId] } : user;
  return canAccessResource(granted, "result.view", resource);
}

function isRoot(notification: Notification): boolean {
  return notification.category === "CRITICAL" && notification.entityType === "RESULT_VERSION" && notification.escalationOf === undefined;
}

function dueEscalations(state: StoreState, policy: CriticalResultPolicy, at: Date): { root: Notification; decision: CriticalEscalationDecision }[] {
  const acknowledged = new Set(state.notifications.filter((entry) => entry.category === "CRITICAL" && entry.state === "ACKNOWLEDGED").map((entry) => entry.entityId));
  return state.notifications.flatMap((root) => {
    if (!isRoot(root) || acknowledged.has(root.entityId)) return [];
    // A notification whose in-app delivery failed was never seen: that is when the climb matters most.
    const state = root.state === "FAILED" ? "PENDING" : root.state;
    const decision = planCriticalEscalation({ notificationId: root.id, createdAt: root.createdAt, state, escalationLevel: root.escalation?.level ?? 0 }, policy, at);
    return decision ? [{ root, decision }] : [];
  });
}

function grantPatientScope(state: StoreState, userId: string, patientId: string, rootId: string, correlationId: string): StoreState {
  const user = findById(state.users, userId);
  if (!user || !PATIENT_SCOPED_ROLES.includes(user.role) || user.patientIds?.includes(patientId)) return state;
  return {
    ...state,
    users: state.users.map((entry) => entry.id === user.id ? { ...entry, patientIds: [...(entry.patientIds ?? []), patientId], version: entry.version + 1 } : entry),
    auditEvents: [...state.auditEvents, createAudit("CriticalEscalationPatientAccessGranted", undefined, "User", user.id, correlationId, undefined, undefined, { notificationId: rootId, patientId })]
  };
}

/**
 * PROD-402 (D3): a critical result nobody acknowledged climbs the policy's recipient ladder at each
 * threshold of CRITICAL_POLICY_ESCALATION_AFTER_MS, counted from the requester's notification. Each step
 * notifies, in the Hub and over WhatsApp, the first rule that reaches someone new (on call, responsible,
 * department manager...). Any acknowledgement of the result version stops the climb. Escalated
 * professionals receive the patient in their scope so they can open the result.
 */
export async function runCriticalEscalation(store: StateStore, options: CriticalEscalationOptions = {}): Promise<CriticalEscalationSummary> {
  const policy = options.policy ?? criticalPolicyFromEnvironment(options.environment ?? process.env);
  if (!policy) return { due: 0, notified: 0, unreachable: 0 };
  const at = options.now ?? new Date();
  // Most cycles have nothing due: decide on the cached read before taking the write lock.
  if (dueEscalations(await store.readState(), policy, at).length === 0) return { due: 0, notified: 0, unreachable: 0 };
  return store.transaction((original) => {
    const due = dueEscalations(original, policy, at);
    let state = original;
    let notified = 0;
    let unreachable = 0;
    for (const { root, decision } of due) {
      const correlationId = id("corr");
      const escalatedAt = at.toISOString();
      const request = requestForNotification(state, root);
      const resource = criticalResultResource(state, root);
      const admission = request?.admissionId ? findById(state.admissions, request.admissionId) : undefined;
      const reached = new Set(state.notifications.filter((entry) => entry.category === "CRITICAL" && entry.entityId === root.entityId).map((entry) => entry.recipientUserId));
      const step = request && resource ? nextCriticalRecipients({
        requesterId: request.requesterId,
        responsibleUserId: admission?.responsibleUserId,
        departmentCode: request.requestingDepartmentCode,
        candidates: state.users
          .filter((user) => canOpenResult(user, resource))
          .map((user) => ({ userId: user.id, role: user.role, departmentCode: user.departmentCode, active: user.active !== false, managedDepartmentCodes: user.managedDepartmentCodes, onCall: user.onCall }))
      }, policy, reached) : undefined;
      const audit: AuditEvent = createAudit("CriticalResultEscalated", undefined, "Notification", root.id, correlationId, String(root.escalation?.level ?? 0), String(decision.level), {
        rule: step?.rule ?? "NONE", recipients: String(step?.recipients.length ?? 0), dueAt: decision.dueAt, resultVersionId: root.entityId
      });
      state = {
        ...state,
        // Like the WhatsApp status, the climb annotates the requester's notification without bumping its version.
        // A level that reaches someone clears the unreachable mark; alertAdministrators restores it otherwise.
        notifications: state.notifications.map((entry) => entry.id === root.id ? { ...entry, escalation: { level: decision.level, lastEscalatedAt: escalatedAt } } : entry),
        auditEvents: [...state.auditEvents, audit]
      };
      if (!request) continue;
      if (!step) {
        // Nobody clinical is left to notify: a silent audit row is not an answer for a critical result.
        // The administrators get an operational alert without clinical data and the root keeps the mark,
        // so metrics and the Prometheus rule see it until someone acknowledges the result (D-056).
        const alerted = alertAdministrators(state, root, request, decision.level, escalatedAt, correlationId);
        if (alerted.firstTime) unreachable += 1;
        state = alerted.state;
        continue;
      }
      for (const recipient of step.recipients) {
        state = grantPatientScope(state, recipient.userId, request.patientId, root.id, correlationId);
        const dedupeKey = `escalation:${root.id}:${recipient.userId}`;
        state = notificationFor(state, {
          category: "CRITICAL", priority: "URGENT", recipientUserId: recipient.userId, entityType: root.entityType, entityId: root.entityId,
          deepLink: root.deepLink, title: "Resultado crítico sem confirmação", body: root.body, dedupeKey, escalationOf: root.id
        });
        const created = state.notifications.find((entry) => entry.dedupeKey === dedupeKey && entry.recipientUserId === recipient.userId)!;
        state = { ...state, outbox: [...state.outbox, createOutbox("CriticalResultEscalated", "Notification", created.id, correlationId, { notificationId: created.id, escalationOf: root.id, level: decision.level })] };
        state = withCriticalWhatsAppAlert(state, created.id, request, correlationId, options.environment ?? process.env);
        notified += 1;
      }
    }
    return { state, result: { due: due.length, notified, unreachable } };
  });
}

/**
 * The operational alert of an exhausted ladder: every active administrator receives an ADMINISTRATIVE
 * notification that names the request protocol and the requesting department, never the patient or the
 * result, with its own delivery intent. One alert per root, whatever the number of levels that find nobody.
 */
function alertAdministrators(
  state: StoreState,
  root: Notification,
  request: { id: string; requestCode: string; requestingDepartmentCode: string },
  level: number,
  at: string,
  correlationId: string
): { state: StoreState; firstTime: boolean } {
  const firstTime = root.escalation?.unreachableAt === undefined;
  let next: StoreState = {
    ...state,
    notifications: state.notifications.map((entry) => entry.id === root.id
      ? { ...entry, escalation: { level, lastEscalatedAt: at, unreachableAt: root.escalation?.unreachableAt ?? at } }
      : entry),
    auditEvents: [...state.auditEvents, createAudit("CriticalResultUnreachable", undefined, "Notification", root.id, correlationId, undefined, undefined, {
      level, departmentCode: request.requestingDepartmentCode, requestCode: request.requestCode, resultVersionId: root.entityId
    })]
  };
  const administrators = next.users.filter((user) => user.role === "ADMIN" && user.active !== false).sort((left, right) => left.id.localeCompare(right.id));
  for (const administrator of administrators) {
    const dedupeKey = `critical-unreachable:${root.id}:${administrator.id}`;
    const before = next.notifications.length;
    next = notificationFor(next, {
      category: "ADMINISTRATIVE", priority: "URGENT", recipientUserId: administrator.id, entityType: "REQUEST", entityId: request.id, deepLink: "/system",
      title: "Crítico sem confirmação e sem destinatário",
      body: `Solicitação ${request.requestCode} · setor ${request.requestingDepartmentCode}: nenhum plantonista ou gestor alcançável para o resultado crítico. Acione o setor por telefone e registre a confirmação.`,
      dedupeKey
    });
    if (next.notifications.length === before) continue;
    const created = next.notifications.at(-1)!;
    next = { ...next, outbox: [...next.outbox, createOutbox(CRITICAL_UNREACHABLE_EVENT, "Notification", created.id, correlationId, { notificationId: created.id, escalationOf: root.id, level })] };
  }
  return { state: next, firstTime };
}
