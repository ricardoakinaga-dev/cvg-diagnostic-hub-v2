# Notifications

**Knowledge status:** `DECISION` de delivery interno para o MVP; destinatários, policy crítica e canal redundante permanecem `OPEN QUESTION`.

## 1. Principles

Notifications are action routing, not a second source of clinical truth. Each notification references an entity/version and opens a deep link; the user can always re-fetch the authorized resource. Toasts are ephemeral feedback and never replace inbox/audit.

## 2. Categories and triggers

| Category | Examples | Priority | Action/ack required |
| --- | --- | --- | --- |
| `INFORMATIONAL` | request created, status progressed, result viewed | normal | no |
| `ACTIONABLE` | recollection, pending reason, overdue, schedule changed, result available | high | mark handled/review workflow |
| `CRITICAL` | critical result detected/released, critical correction | urgent | explicit acknowledgement and escalation |
| `ADMINISTRATIVE` | role/config or service availability change | normal/high | according to policy |

Triggers use canonical events: `ResultReleased`, `RecollectionRequested`, `DiagnosticItemOverdue`, `ProcedureRescheduled`, `CriticalResultDetected`, `ResultAmended`, `ResultVoided`, `DiagnosticItemCancelled`.

## 3. Recipient resolution

1. explicit responsible professional if valid and on duty;
2. care team for patient/encounter;
3. executing department queue;
4. configured manager/fallback;
5. unresolved recipient creates an operational alert, never a silently dropped notification.

`OPEN QUESTION`: exact ownership, shift handoff and critical fallback are OQ-004/OQ-018.

## 4. Delivery model

MVP channel: `IN_APP`. Future channels (`PUSH`, `EMAIL`, `WHATSAPP`, `WEBHOOK`) require separate consent, authentication, delivery/receipt semantics and ADR. Notification intent is written to outbox in the same transaction as the event; worker retries with bounded backoff and dedupe key.

Delivery states: `PENDING`, `DELIVERED`, `SEEN`, `ACKNOWLEDGED`, `FAILED`, `SUPERSEDED`, `ESCALATED`. `DELIVERED` means recorded in inbox, not clinically received. Acknowledgement is accepted only after `DELIVERED`/`SEEN`; `PENDING` and `FAILED` remain operational delivery states, and `SUPERSEDED` cannot be acknowledged. For critical results only `ACKNOWLEDGED` satisfies the communication policy.

## 5. Critical result rules

- Critical policy is configured/versioned; no threshold is hardcoded from this document.
- Release of a critical version creates at least one `CRITICAL` notification and an audit event.
- Notification includes patient-safe context, request code/item/service, result version reference and “open result” action; do not put full sensitive content in push/SSE payload.
- Recipient must acknowledge; reminders/escalations use policy deadline.
- Correction creates a new notification decision; old acknowledgement remains historical and does not automatically acknowledge the new version.
- When an unacknowledged critical version is amended or voided, its notification becomes `SUPERSEDED` and the current version requires a new notification decision.
- Amendment (`DECISION` D-055, 2026-10-10): at the moment a released version is amended, every recipient of any notification about a version of that result (requester, escalated on-call staff, managers) receives an `ACTIONABLE` notice "Resultado em retificação" (`URGENT` when the superseded version was critical; dedupe `amend:<supersededVersionId>:<userId>`) with its own outbox delivery intent, in the same transaction as the `ResultAmended` event. The corrected version is a draft until released again; the notice says to wait for the new release.
- Release of a version with `supersedesId` is titled "Resultado retificado" (critical: "Resultado crítico retificado requer confirmação") and reaches the requester plus the same earlier recipients (dedupe `release:<versionId>:<userId>`); only the requester's critical notification is a root of the escalation ladder. Deactivated accounts receive nothing.
- Void of a released/reviewed/completed version creates `ResultVoided`, informs affected recipients — the requester and everyone notified about an earlier version (D-055) — that the prior version is invalid and points to the replacement/operational action; the void itself is never treated as a successful clinical result.
- Failure to deliver/acknowledge stays in a manager queue and is visible in dashboard.

## 6. Fatigue controls

- dedupe same event/entity/version/recipient;
- group informational updates while preserving actionables/criticals;
- user preferences may mute informational classes only, never required critical alerts;
- no more than one notification per state change per recipient unless escalation policy says otherwise;
- notifications expire only by policy and remain in audit/history.

## 7. UI contract

Inbox tabs: `Novas`, `Não lidas`, `Ação necessária`, `Todas`. Every row shows patient-safe identity, item/service, status/action, relative and absolute timestamp when useful, priority label/icon, and deep link. Empty state explains that no action is pending. Loading/error/offline/degraded states are specified in [`../ux/SCREEN_SPECIFICATIONS.md`](../ux/SCREEN_SPECIFICATIONS.md).
