# API Specification

**Knowledge status (19/08/2026):** `DECISION/CONTRACT` normativo; a implementação local cobre parte deste contrato em `src/app/api/v1/[...path]/route.ts`. A presença de uma operação nesta especificação não significa que sua política hospitalar ou integração produtiva esteja aprovada.

**Status:** contrato planejado para OpenAPI 3.1; envelope, health, sessão, requests, workflows, results, attachments, notifications, queries e realtime possuem implementação local parcial/funcional conforme a matriz de build.  
**Base path:** `/api/v1`  
**Formato:** JSON UTF-8; timestamps ISO-8601 UTC; labels traduzidas na UI.

## 1. Conventions

### Success envelope

```json
{
  "data": { "id": "01J...", "requestCode": "EX-260818-0042" },
  "meta": { "requestId": "req_01J...", "correlationId": "corr_01J..." }
}
```

Collections add `meta.nextCursor`, `meta.limit` and stable ordering. Errors follow [`../spec/ERROR_MODEL.md`](../spec/ERROR_MODEL.md). `X-Correlation-Id` may be supplied but is validated/rotated; server value is authoritative in response.

### IDs and headers

- Internal resource IDs are opaque strings. The production relational target is UUIDv7 or another approved monotonic UUID equivalent; the current local/synthetic runtime may use prefixed opaque IDs and clients must never parse or construct them.
- Human request identifier: `requestCode`.
- Mutating clinical commands: `Idempotency-Key` and `If-Match`/`expectedVersion` where specified. Patient registration also requires an idempotency key because it creates a patient and an initial encounter atomically.
- Auth: secure server session cookie; future OIDC boundary does not expose bearer tokens to local storage. `POST /session/reauth` records a short-lived password reauthentication on the session for sensitive access-management commands.

### Pagination/filtering

List endpoints accept `limit` (default 25, max 100), opaque keyset `cursor`, `sort`, and resource-specific filters. Search cursors encode the last rank/updatedAt/id tuple and timeline cursors encode occurredAt/id; clients must treat them as opaque. No endpoint returns unbounded clinical data. Filters use stable enum codes. Every collection client must retain `meta.nextCursor` when present and send it back as the opaque `cursor` query parameter; it must not infer completion from row count alone. This applies in particular to `GET /queues/{departmentCode}/items`, including each queue in a manager's delegated scope.

### Idempotency and concurrency matrix

`Idempotency-Key` is mandatory for `release`, `amend`, `void`, `request-recollection`, `cancel`, `review`, `complete` and attachment `finalize`; it is recommended for draft creation and schedule commands. These commands also send `expectedVersion`/`If-Match` when a mutable resource is involved. A repeated key with the same payload returns the original committed response; a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.

| Endpoint command | Idempotency-Key | Concurrency guard |
| --- | --- | --- |
| `POST /diagnostic-requests` | recommended for create; required for duplicate override retry | context/payload hash |
| `POST /patients` | required | patient + initial encounter transaction |
| `POST /diagnostic-requests/{id}/cancel`, `POST /diagnostic-items/{id}/cancel`, `POST /diagnostic-items/{id}/reject` | required | `expectedVersion` |
| `POST /diagnostic-items/{id}/receive-sample`, `/start-processing`, `/request-recollection` | required for recollection; recommended/required by command policy for receive/start | `expectedVersion` |
| `POST /samples/{id}/receive-replacement` | required | sample/item version |
| `POST /diagnostic-items/{id}/schedule`, `/reschedule`, `/start-procedure`, `/mark-performed` | recommended; required when retry can duplicate an operational event | procedure/item version |
| `POST /diagnostic-items/{id}/results` and `PATCH /results/{id}/draft` | recommended for create; expected version for patch | draft/result version |
| `POST /results/{id}/release`, `/amend`, `/void`, `/view`, `/review` | required | result/item version |
| `POST /diagnostic-items/{id}/complete` | required | item version |
| `POST /result-versions/{id}/attachments/upload-session`, `POST /attachments/{id}/finalize` | required | attachment/version state |
| `POST /notifications/{id}/acknowledge` | required | notification version, non-empty reason and explicit confirmation |
| `POST /users` | required | recent password reauthentication, operational role/scope validation, non-empty reason and explicit confirmation |
| `POST /users/{id}/roles` | required | recent password reauthentication, target `expectedVersion`, non-empty reason and explicit confirmation |
| `DELETE /users/{id}` | required | recent password reauthentication, target `expectedVersion`, non-empty reason and explicit confirmation; soft deactivation |

## 2. Resources

| Resource | Endpoints | Primary permission |
| --- | --- | --- |
| Session | `POST /session/login`, `GET /session/me`, `POST /session/logout`, `POST /session/reauth`, `POST /session/password`, `POST /session/password/change` | authenticated session boundary |
| Observability | `GET /metrics` | `health.readiness`, or the Prometheus bearer token |
| Patients | `GET /patients`, `POST /patients`, `GET /patients/{id}`, `GET /patients/{id}/diagnostics`, `GET /patients/{id}/encounters` | scoped view/create |
| Encounters/admissions | `GET /encounters/{id}`, `GET /admissions/{id}`, `POST /admissions/{id}/context` | scoped view; approved context policy for mutation |
| Diagnostic requests | `POST /diagnostic-requests`, `GET /diagnostic-requests`, `GET /diagnostic-requests/{id}` | create/view scope |
| Request items | `GET /diagnostic-items/{id}` | item scope |
| Results | `GET /results/{id}`, `GET /results/{id}/versions` | result scope |
| Reports/attachments | `GET /reports/{id}`, upload session/content/finalize/download | result + file scope |
| Notifications | `GET /notifications`, `POST /notifications/{id}/acknowledge` | recipient |
| Catalog | `GET /diagnostic-services`, `GET /diagnostic-services/{serviceId}/result-template`, `GET /reason-codes`, admin commands | config permission |
| Users and roles | `GET/POST /users`, `POST /users/{id}/roles`, `DELETE /users/{id}` | `user_role.manage` (ADMIN or delegated MANAGER scope); credentials are never returned; changes require reauthentication and audit; ADMIN can configure a MANAGER's `managedDepartmentCodes` |
| Management control | `GET /management/overview` | `dashboard.view` + `user_role.manage`; one scoped snapshot for requests, pending work, departments and operational indicators |
| Search | `GET /search` | scoped search |
| Audit/timeline | `GET /audit-events`, `GET /timeline` | scoped/manager |
| Dashboard | `GET /dashboard`, `GET /management/overview` | scoped dashboard; manager overview additionally requires management scope |
| Health | `GET /livez`, `GET /readyz` | liveness/readiness policy |
| Realtime | `GET /realtime/events` | session + scope |

## 2.1 Endpoint authorization contract

Every endpoint below performs a server-side check for each listed canonical permission before returning data or executing a command. The identifiers are defined in [`../spec/PERMISSIONS.md`](../spec/PERMISSIONS.md). The check also applies the resource scope, current-state transition and policy conditions in that document; a role name or client-supplied department never bypasses it. If more than one permission is listed, all are required.

| Method and path | Required permission(s) | Additional condition/scope |
| --- | --- | --- |
| `GET /livez` | none | public liveness boundary; no dependency payload |
| `GET /readyz` | none | public readiness boundary; checks configured dependencies and fails closed |
| `GET /metrics` | `health.readiness` | readiness-capable configuration actor, or `Authorization: Bearer <METRICS_SCRAPE_TOKEN>` (32+ characters, constant-time comparison, accepted by no other route); bounded Prometheus labels and no clinical payload |
| `POST /session/login` | none | public credential boundary; issues secure session and CSRF cookies |
| `GET /session/me` | authenticated active session | returns only the current user/session projection |
| `POST /session/logout` | authenticated active session | revokes the current session and clears cookies |
| `POST /session/reauth` | authenticated active session | current password and step-up timestamp; never returns credentials |
| `POST /session/password/change` | authenticated active session (not a temporary password) | PROD-201: current password checked outside the transaction (`CURRENT_PASSWORD_INVALID` otherwise), 5 attempts per account per 15 minutes, new password of 12–200 characters with letters and digits and different from the current one; revokes every session of the user, issues new session and CSRF cookies and audits `PasswordChanged` without secrets |
| `GET /patients` | `patient.view` | only authorized patient search fields |
| `POST /patients` | `patient.create` | VETERINARIAN or INPATIENT_TEAM; creates the patient and an open initial encounter, with ward/bed required only for inpatient |
| `GET /patients/{id}` | `patient.view` | CARE/assigned or manager request/item department scope; no local ADMIN patient scope |
| `GET /patients/{id}/diagnostics` | `patient.view`, `diagnostic.timeline.view` | CARE/assigned patient scope; paginated |
| `GET /patients/{id}/encounters` | `encounter.view` | patient scope; returns only that patient's encounters |
| `POST /patients/{id}/encounters` | `encounter.manage` | patient scope or manager delegation; one open encounter per patient; idempotent |
| `GET /encounters/{id}` | `encounter.view` | patient/encounter scope |
| `POST /encounters/{id}/close` | `encounter.manage` | patient scope or manager delegation; encounter must be `OPEN`; never cancels exams; idempotent |
| `GET /admissions/{id}` | `admission.view` | WARD/CARE scope |
| `POST /admissions/{id}/context` | `admission.context.manage` | approved D-01 policy, manager delegation, `If-Match`/`expectedVersion` and idempotency |
| `POST /diagnostic-requests` | `request.create` | duplicate override additionally requires `request.duplicate_override` |
| `GET /diagnostic-requests` | `request.list` | filters cannot widen actor scope |
| `GET /diagnostic-requests/{id}` | `request.view` | request patient and department scope |
| `POST /diagnostic-requests/{id}/cancel` | `request.cancel` | eligible phase, reason and policy |
| `GET /diagnostic-items/{id}` | `item.view` | item patient and service/department scope |
| `POST /diagnostic-items/{id}/cancel` | `item.cancel` | eligible phase, reason and policy |
| `POST /diagnostic-items/{id}/reject` | `item.reject` | executor service and reason |
| `POST /diagnostic-items/{id}/complete` | `item.complete` | explicit manager/policy path only |
| `POST /diagnostic-items/{id}/receive-sample` | `sample.receive` | service must be Laboratory |
| `POST /diagnostic-items/{id}/start-processing` | `sample.process` | service must be Laboratory and state transition valid |
| `POST /diagnostic-items/{id}/request-recollection` | `sample.recollection.request` | service must be Laboratory and reason required |
| `POST /samples/{id}/receive-replacement` | `sample.replacement.receive` | active recollection chain and Laboratory scope |
| `POST /diagnostic-items/{id}/schedule` | `procedure.schedule` | service must be RX/US; department/resource scope |
| `POST /procedures/{id}/reschedule` | `procedure.reschedule` | service, resource and scheduling policy |
| `POST /diagnostic-items/{id}/start-procedure` | `procedure.start` | executor service and scheduled window |
| `POST /diagnostic-items/{id}/mark-performed` | `procedure.mark_performed` | executor service; performed metadata required |
| `GET /results/{id}` | `result.view` | CARE/SERVICE scope; version visibility policy |
| `GET /results/{id}/versions` | `result.history.view` | historical access policy and scope |
| `POST /diagnostic-items/{id}/results` | `result.draft.create` | executor service and draft policy |
| `PATCH /results/{id}/draft` | `result.draft.edit_own` | current unreleased draft owned by actor/service |
| `POST /results/{id}/release` | `result.release` | executor service, release policy and current version |
| `POST /results/{id}/amend` | `result.amend` | released version, reason and amendment policy |
| `POST /results/{id}/void` | `result.void` | approved exception policy, reason and version guard |
| `POST /results/{id}/view` | `result.view`, `result.view.record` | exact visible version and scoped patient/resource |
| `POST /results/{id}/review` | `result.review` | care/policy scope; exact current version |
| `GET /reports/{id}` | `result.view`, `attachment.view` | report and referenced files share result scope |
| `POST /result-versions/{id}/attachments/upload-session` | `attachment.upload_session` | actor may edit the owning result/service |
| `PUT /attachments/{id}/content` | `attachment.finalize` | bounded binary media and size boundary; upload remains bound to the issued session |
| `POST /attachments/{id}/finalize` | `attachment.finalize` | owning result/service and scan/checksum policy |
| `GET /attachments/{id}/download` | `attachment.download`, `attachment.view` | short-lived authorized download only |
| `GET /notifications` | `notification.view` | recipient scope; no cross-user listing |
| `POST /notifications/{id}/acknowledge` | `notification.view`, `notification.acknowledge` | recipient or explicit manager policy; `expectedVersion`, non-empty `reason` and `confirm: true` |
| `GET /queues/{departmentCode}/items` | `queue.view` | assigned department; department code is not authority |
| `GET /timeline` | `timeline.view` | request/item scope and cursor filters |
| `GET /search` | `search.execute` | every returned record is independently scope-filtered |
| `GET /diagnostic-services` | `service.catalog.view` | authenticated operational scope |
| `GET /diagnostic-services/{serviceId}/result-template` | `service.catalog.view` | executor service scope; returns the configured versioned template only |
| `GET /diagnostic-services?includeInactive=true` | `service.catalog.manage` | admin/delegated manager scope; inactive values remain visible only for configuration |
| `POST /diagnostic-services` | `service.catalog.manage` | admin/delegated manager policy; creates a versioned catalog entry |
| `PATCH /diagnostic-services/{id}` | `service.catalog.manage` | admin/delegated manager policy; all editable fields are versioned, while referenced structural changes fail safely with `CATALOG_IN_USE` |
| `POST /sla-policies/{id}` | `sla_policy.manage` | **planned/policy-gated**; not exposed by the current runtime manifest until D-04 is approved |
| `PATCH /sla-policies/{id}` | `sla_policy.manage` | **planned/policy-gated**; not exposed by the current runtime manifest until D-04 is approved |
| `POST /critical-result-policies/{id}` | `critical_result_policy.manage` | **planned/policy-gated**; not exposed by the current runtime manifest until D-03 is approved |
| `PATCH /critical-result-policies/{id}` | `critical_result_policy.manage` | **planned/policy-gated**; not exposed by the current runtime manifest until D-03 is approved |
| `POST /reason-codes` | `reason_code.manage` | admin/delegated manager policy; creates an auditable code |
| `PATCH /reason-codes/{id}` | `reason_code.manage` | admin/delegated manager policy and version guard |
| `GET /reason-codes` | `reason_code.manage` | configuration actors only; inactive values retained for audit |
| `GET /users` | `user_role.manage` | ADMIN or delegated MANAGER; only manageable users in the actor's scope; safe fields only |
| `POST /users` | `user_role.manage` | ADMIN or delegated MANAGER; operational roles only for delegated managers; recent reauthentication, reason, confirmation and audit; ADMIN may define `managedDepartmentCodes` for a new MANAGER |
| `POST /users/{id}/roles` | `user_role.manage` | ADMIN or delegated MANAGER target scope; recent password reauthentication, target `expectedVersion`, reason, confirmation and audit; ADMIN may revise a MANAGER's `managedDepartmentCodes` |
| `DELETE /users/{id}` | `user_role.manage` | ADMIN or delegated MANAGER target scope; soft deactivation, session revocation, version guard and audit |
| `GET /management/overview` | `dashboard.view`, `user_role.manage` | active MANAGER only; data is filtered to own department plus explicitly managed diagnostic departments |
| `GET /dashboard` | `dashboard.view` | department and patient scope; bounded operational indicators only |
| `GET /audit-events` | `audit.view` | manager/admin or scoped audit policy |
| `GET /realtime/events` | `realtime.connect` | authenticated session and event scope |

This table is exhaustive for the planned routes in this document. The executable boundary is `src/server/http/api-operation-manifest.ts` and its generated OpenAPI validation; policy-gated rows above are intentionally not runtime operations yet. Any new route must add a canonical permission, scope rule and operation-traceability row in the same change.

## 3. Request commands

### Register patient and initial encounter

`POST /patients`

```json
{
  "displayName": "Amora",
  "species": "Canino",
  "breed": "Labrador",
  "sex": "Fêmea",
  "birthDate": "2022-06-14",
  "ownerLabel": "M. Ribeiro",
  "externalId": "HIS-AMORA-001",
  "encounterType": "OUTPATIENT"
}
```

The veterinarian or inpatient team may register a patient from the patient area or directly from the request dialog. The server generates an external identifier when omitted, opens the initial encounter, assigns the patient to the actor's care scope and returns `201`. For `INPATIENT`, `ward` and `bed` are required and an admission is created in the same transaction. Reusing the same idempotency key with the same payload returns the original result; a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.

### Open and close encounters

`POST /patients/{patientId}/encounters` (`openPatientEncounter`, `encounter.manage`, `Idempotency-Key` required) body `{ "encounterType": "OUTPATIENT|EMERGENCY|INPATIENT", "ward"?, "bed"?, "reason"? }`. The patient must be active and in the actor's scope (otherwise scoped `404`); a patient with an open encounter returns `409 ENCOUNTER_ALREADY_OPEN`. `INPATIENT` requires `ward` and `bed` and creates the admission in the actor's department; other types reject both. Returns `201` with `{ encounter, admission? }`, audits `EncounterCreated` (+ `AdmissionCreated`) and emits the `EncounterOpened` outbox event.

`POST /encounters/{encounterId}/close` (`closeEncounter`, `encounter.manage`, `Idempotency-Key` required, no `If-Match`) body `{ "reason"? }` (1–500 characters). The encounter must be `OPEN` (`409 INVALID_STATE_TRANSITION` otherwise). Sets `CLOSED` and `closedAt`, discharges an open admission of the encounter (`AdmissionDischarged`) and leaves every diagnostic item untouched (D9). Returns `200` with `{ encounter, admission?, pendingItems }`, audits `EncounterClosed` with `pendingItems` and `reason`, and emits the `EncounterClosed` outbox event.

### Create request

`POST /diagnostic-requests`

```json
{
  "patientId": "01J...",
  "encounterId": "01J...",
  "admissionId": "01J...",
  "priority": "URGENT",
  "items": [
    { "serviceId": "01J...", "note": "Jejum conforme protocolo" },
    { "serviceId": "01J..." }
  ]
}
```

Server fills requester/department/time, validates patient/encounter relationship, applies duplicate warning policy and returns `201` with request + item summary. A request on a `CLOSED` encounter is refused with `409 ENCOUNTER_CLOSED`. If duplicate needs decision, return a safe `409 DUPLICATE_WARNING` with existing request code/status only if actor may see it; authorized override repeats with `overrideReason` and idempotency key.

### Cancel/reject

- `POST /diagnostic-requests/{id}/cancel` — cancels eligible items or selected `itemIds`; body requires `reasonCode`, optional note, expected versions.
- `POST /diagnostic-items/{id}/cancel` — cancels one item in an eligible phase (`SCHEDULED`, `RECOLLECTION_REQUIRED`, `FAILED`, or elevated `AWAITING_REPORT` policy), with reason and expected version.
- `POST /diagnostic-items/{id}/reject` — executor rejection with reason.
- `POST /diagnostic-items/{id}/complete` — explicit manager/policy command when automatic completion after review is disabled; otherwise completion is emitted by the review transaction.

Cancellation never deletes. Partial item cancellation returns updated aggregate summary.

## 4. Laboratory commands

- `POST /diagnostic-items/{id}/receive-sample` — body `accessionCode` or create sample metadata, sample type, expectedVersion.
- `POST /diagnostic-items/{id}/start-processing` — expectedVersion.
- `POST /diagnostic-items/{id}/request-recollection` — reasonCode, note, affected sample ID, expectedVersion.
- `POST /samples/{id}/receive-replacement` — accession/sample metadata and item links.

Each command verifies service workflow, actor role, patient/request consistency and idempotency. Response returns item, sample chain summary and next actions.

## 5. Imaging commands

- `POST /diagnostic-items/{id}/schedule` — start/end/resource, expectedVersion.
- `POST /procedures/{id}/reschedule` — new window + reason + expectedVersion.
- `POST /diagnostic-items/{id}/start-procedure`.
- `POST /diagnostic-items/{id}/mark-performed` — performed metadata/attachments references.

Schedule conflict returns `409 SCHEDULE_CONFLICT`; previous schedule remains history. No endpoint edits a schedule row in place after a meaningful event.

## 6. Result commands

- `POST /diagnostic-items/{id}/results` — create draft; requires service schema.
- `PATCH /results/{id}/draft` — edit only current draft, expected version.
- `POST /results/{id}/release` — release current draft; `Idempotency-Key` mandatory.
- `POST /results/{id}/amend` — new version, reason, content delta/snapshot; release policy applies.
- `POST /results/{id}/void` — only approved exception policy; reason mandatory; returns item `RESULT_VOIDED`, `replacementRequired=true`, affected notification references and current invalidated version.
- `POST /results/{id}/view` — records view of `versionId`, idempotent per policy.
- `POST /results/{id}/review` — records review of exact current version; `409 REVIEW_STALE` if changed.
- `POST /notifications/{id}/acknowledge` — critical/eligible notification acknowledgement; the server accepts only delivered/seen, current notifications and rejects pending, failed or superseded delivery states.

`PATCH` is never available against a released version. `GET /results/{id}` returns current version plus version/review status according to scope; historical versions require separate permission/route.

`void` semantics: a released/reviewed/completed version becomes `VOIDED` for audit, the item becomes `RESULT_VOIDED` (non-terminal), prior view/review/acknowledgement records remain historical, the aggregate reopens as active when applicable, and a replacement result must be created/released/reviewed or the item must be cancelled through the phase/policy command. A voided draft before release is discarded through the draft policy and never presented as a released result.

## 7. Attachments

1. `POST /result-versions/{id}/attachments/upload-session` returns a short-lived upload URL and expected checksum/limits; mutating upload flows use `Idempotency-Key`.
2. The production target may use a signed S3-compatible URL. The current local runtime exposes the same contract through the authenticated `PUT /attachments/{id}/content` boundary, so storage credentials and object keys never reach the client.
3. `POST /attachments/{id}/finalize` validates size/MIME/checksum/scan state and requires `Idempotency-Key`.
4. `GET /attachments/{id}/download` returns authorized short-lived URL or streams through a safe proxy.

Result release cannot reference attachment with `PENDING`, `FAILED` or `QUARANTINED` scan status when policy requires clean content.

## 8. Query endpoints

- `GET /diagnostic-requests?status=&departmentCode=&priority=&serviceId=&overdue=&from=&to=&cursor=&limit=` filters visible items before applying the cursor; `from`/`to` bound request creation time and `overdue` is derived from server time and terminal state.
- `GET /queues/{departmentCode}/items?...` returns action-oriented cards/table rows.
- `GET /patients/{id}/diagnostics?cursor=` returns timeline/summary scoped to patient.
- `GET /timeline?requestId=&itemId=&cursor=&limit=` returns event-derived entries with stable occurredAt/id keyset pagination and rejects a request/item pair from different contexts.
- `GET /dashboard` returns the current authorized state with five indicator groups (`overdue`, `recollections`, `newResults`, `critical`, `totalActive`). Each group includes `count`, numeric `denominator`, `denominatorDefinition`, `definition` and `nextAction`; the response also includes `window.kind=CURRENT_STATE`, `window.asOf`, `window.timezone` and `updatedAt`. Manager denominators include only items in the assigned/managed departments.
- `GET /management/overview` returns a single scoped management snapshot: scope label, request/item counters, pending items with next action and deep link, recent requests, and department rollups. It is the data source for the manager control center tabs `Controle`, `Solicitações`, `Pendências` and `Estatísticas`.
- `GET /search?q=&types=&status=&departmentCode=&from=&to=&cursor=&limit=` follows [`../spec/SEARCH.md`](../spec/SEARCH.md), applies authorization before ranking/counting and uses a stable rank/updatedAt/id keyset cursor.

## 9. Configuration endpoints

Administrative commands are explicit, audited and protected:

- `POST /diagnostic-services` and `PATCH /diagnostic-services/{id}`;
- `POST/PATCH /sla-policies/{id}`;
- `POST/PATCH /critical-result-policies/{id}`;
- `POST /reason-codes` and `PATCH /reason-codes/{id}`;
- `GET/POST /users`, `POST /users/{id}/roles` and `DELETE /users/{id}`.

No endpoint allows deleting a referenced service, policy or reason; deactivate/version instead. User deletion is also intentionally a soft deactivation: active sessions are revoked and the audit trail remains intact.

## 10. Contract requirements

- OpenAPI schema generated/checked in CI when implementation exists.
- Schema validation rejects unknown/oversized input per policy.
- Error code list is shared with frontend types.
- Commands emit the event names in [`../spec/REALTIME.md`](../spec/REALTIME.md) and [`../spec/STATE_MACHINES.md`](../spec/STATE_MACHINES.md).
- Integration tests exercise API middleware, persistence, authorization and outbox—not only service methods.
