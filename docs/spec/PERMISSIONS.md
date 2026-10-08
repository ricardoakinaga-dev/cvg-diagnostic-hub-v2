# Permissions and authorization

**Knowledge status:** `DECISION/PROPOSAL` de RBAC; a autorização real do hospital é `OPEN QUESTION` até aprovação de OQ-001/OQ-002/OQ-017.

## 1. Model

Authorization is evaluated server-side as:

```text
can(actor, action, resource, scope, current_state, policy_version)
```

Authentication alone never grants access. Scope is the intersection of role assignment, department/service responsibility, patient/encounter care relationship and explicit manager permissions. Deny by default; the UI may hide unavailable actions but the API must enforce them again. In the local boundary, `ADMIN` is a technical/configuration role: it has no clinical command permissions and cannot enter patient scope. A future break-glass path must be separately approved, time-limited, reasoned and audited.

## 1.1 Canonical permission identifiers

The following identifiers are the authorization contract used by the API specification and the traceability matrix. The role table below grants these permissions only within the actor's scope and current-state policy; an identifier is not a blanket entitlement.

| Permission ID | Action represented | Typical scope |
| --- | --- | --- |
| `patient.view` | View patient and identity context | CARE/assigned |
| `patient.create` | Register patient and open the initial encounter | VETERINARIAN/INPATIENT scope |
| `encounter.view` | View encounter | CARE/assigned |
| `admission.view` | View admission/ward context | WARD/CARE |
| `request.create` | Create diagnostic request | CARE/department |
| `request.list` | List diagnostic requests | DEPARTMENT/CARE |
| `request.view` | View request details | CARE/DEPARTMENT |
| `request.duplicate_override` | Override duplicate warning | manager/policy |
| `request.cancel` | Cancel request before or during eligible phase | requester/manager/policy |
| `item.view` | View diagnostic item and state | CARE/DEPARTMENT |
| `item.cancel` | Cancel one eligible item | requester/manager/policy |
| `item.reject` | Reject an item/sample in executor workflow | SERVICE/manager |
| `sample.receive` | Receive/accession a sample | SERVICE=LAB |
| `sample.process` | Start or advance laboratory processing | SERVICE=LAB |
| `sample.recollection.request` | Request recollection | SERVICE=LAB/manager |
| `sample.replacement.receive` | Receive replacement sample | SERVICE=LAB |
| `procedure.schedule` | Schedule imaging procedure | SERVICE=RX/US |
| `procedure.reschedule` | Reschedule imaging procedure | SERVICE=RX/US/manager |
| `procedure.start` | Start imaging procedure | SERVICE=RX/US |
| `procedure.mark_performed` | Record performed imaging procedure | SERVICE=RX/US |
| `result.draft.create` | Create a result draft | SERVICE |
| `result.draft.edit_own` | Edit own unreleased draft | SERVICE/own draft |
| `result.release` | Release a result/report | SERVICE/policy |
| `result.amend` | Amend a released result | SERVICE/manager policy |
| `result.void` | Void a released result | SERVICE/manager policy |
| `result.view` | View current result/report | CARE/SERVICE |
| `result.history.view` | View historical result versions | CARE/SERVICE/manager |
| `result.view.record` | Record that a result version was viewed | authenticated scoped actor |
| `result.review` | Review a result version | CARE/policy |
| `item.complete` | Manually complete an item | manager/policy |
| `attachment.view` | View attachment metadata/content reference | result scope |
| `attachment.upload_session` | Create an attachment upload session | own result/SERVICE |
| `attachment.finalize` | Finalize and scan an attachment | own result/SERVICE |
| `attachment.download` | Download attachment content | CARE/SERVICE/manager |
| `notification.view` | View recipient notifications | recipient |
| `notification.acknowledge` | Acknowledge eligible notification | recipient/manager |
| `service.catalog.view` | View diagnostic service catalog | authenticated operational scope |
| `service.catalog.manage` | Create/update/deactivate service | admin/manager policy |
| `sla_policy.manage` | Manage SLA policies | admin/manager policy |
| `critical_result_policy.manage` | Manage critical-result policies | admin/manager policy |
| `reason_code.manage` | Manage reason codes | admin/manager policy |
| `user_role.manage` | Provision, update and deactivate operational users/roles | admin or delegated manager target scope |
| `queue.view` | View operational queue | DEPARTMENT |
| `dashboard.view` | View operational indicators | DEPARTMENT/manager |
| `diagnostic.timeline.view` | View patient diagnostic timeline | CARE/assigned |
| `timeline.view` | View request/item event timeline | scoped resource |
| `audit.view` | View audit events | manager/admin/scoped |
| `search.execute` | Search authorized resources | actor's scope |
| `health.liveness` | Read liveness status | platform/internal policy |
| `health.readiness` | Read readiness status | platform/internal policy |
| `realtime.connect` | Subscribe to scoped realtime events | authenticated session/scope |

## 2. Initial roles

| Role | Default responsibility | Default scope |
| --- | --- | --- |
| `ADMIN` | identity and system configuration | technical; no clinical command or patient scope locally |
| `MANAGER` | operational queues, overrides, delegated configuration and collaborator access | own department plus explicitly managed diagnostic departments; request/item access is department-scoped; an `ADMIN` provisions the delegated department set |
| `VETERINARIAN` | register patient, request, view and review for care scope | assigned patients/encounters/departments |
| `INPATIENT_TEAM` | register patient, request/view/review for admitted patients | assigned ward/department |
| `LAB_TECH` | receive/process/recollect/release lab work | Laboratory |
| `RADIOLOGY_TEAM` | schedule/perform/release RX work | Radiology |
| `ULTRASOUND_TEAM` | schedule/perform/release US work | Ultrasonography |
| `VIEWER` | read-only operational access | explicitly assigned scope |

Roles are configurable and must be mapped to named permissions. A role cannot be inferred from a department label in the client.

## 3. Action matrix

Legend: `✓` allowed within scope and state; `△` allowed only with extra condition/manager policy; `—` denied.

| Action | ADMIN | MANAGER | VET | INPATIENT | LAB | RADIOLOGY | ULTRASOUND | VIEWER |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search authorized resources | — (break-glass only) | ✓ assigned scope | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Register patient + initial encounter | — | — | ✓ | ✓ | — | — | — | — |
| Create diagnostic request | — (break-glass only) | △ | ✓ | ✓ | △ | △ | △ | — |
| Override duplicate warning | △ | ✓ | △ reason | △ reason | △ | △ | △ | — |
| View request/item | — (break-glass only) | ✓ assigned department | ✓ care | ✓ ward | ✓ lab | ✓ imaging | ✓ imaging | ✓ assigned |
| Receive lab sample | — | △ | — | — | ✓ | — | — |
| Start lab processing | — | △ | — | — | ✓ | — | — |
| Request lab recollection | — | △ | — | — | ✓ | — | — |
| Schedule/reschedule RX | — | △ | — | △ request | — | ✓ | — |
| Schedule/reschedule US | — | △ | — | △ request | — | — | ✓ |
| Perform image exam | — | △ | — | — | — | ✓ RX | ✓ US |
| Create result draft | — | △ | — | — | ✓ lab | ✓ RX | ✓ US |
| Edit own result draft | — | △ | — | — | ✓ before release | ✓ before release | ✓ before release |
| Release result/report | — | △ override | — | — | ✓ own service | ✓ own service | ✓ own service |
| Amend released result | — (break-glass only) | ✓ policy/department | — | — | △ owner | △ owner | △ owner |
| Void released result | — (break-glass only) | ✓ policy/department | — | — | △ owner/policy | △ owner/policy | △ owner/policy |
| Create attachment upload session | — | △ | — | — | ✓ own result | ✓ own result | ✓ own result |
| Finalize attachment/upload scan | — | △ | — | — | ✓ own result | ✓ own result | ✓ own result |
| Download attachment | — | ✓ | ✓ scope | ✓ scope | ✓ service | ✓ service | ✓ service | — |
| View attachment | — | ✓ | ✓ scope | ✓ scope | ✓ service | ✓ service | ✓ service |
| View result | — | ✓ | ✓ care | ✓ ward | ✓ service | ✓ service | ✓ service |
| Record result view | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Review result | — | △ | ✓ | ✓ if policy | — | — | — |
| Acknowledge critical notification | — | ✓ | ✓ recipient | ✓ recipient | ✓ recipient | ✓ recipient | ✓ recipient | — |
| Cancel before execution | △ | ✓ | △ requester | △ requester | △ service | △ service | △ service | — |
| Cancel/reject after start | △ support | ✓ policy | —/△ | —/△ | △ manager | △ manager | △ manager | — |
| Complete item manually | △ | △ policy | — | — | — | — | — | — |
| View audit/timeline | △ | ✓ | ✓ scope | ✓ scope | ✓ scope | ✓ scope | ✓ scope | △ |
| Configure catalog/SLA/reasons | ✓ | △ delegated | — | — | △ proposal | △ proposal | △ proposal | — |
| Manage users/roles (inclui gerar senha temporária e link de redefinição de uso único) | ✓, including MANAGER delegated-scope configuration | ✓ operational users in managed scope | — | — | — | — | — | — |
| Export/delete/archive | ✓ with policy | △ approval | — | — | — | — | — | — |

The matrix is a starting policy, not a claim of current hospital authorization. OQ-001/OQ-002/OQ-003/OQ-017 must be resolved before production.

## 4. Resource scopes

- `CARE`: patient/encounter is assigned to actor’s current care team or explicit coverage.
- `DEPARTMENT`: item’s executor/requesting department matches role assignment.
- `WARD`: current admission location is within actor’s ward/shift scope.
- `SERVICE`: item’s `DiagnosticService` is one the role executes.
- `SITE`: future boundary; single-site MVP uses one configured site but does not assume multi-tenant behavior.
- `BREAK_GLASS`: time-limited, reason-required, audited access; must not be enabled by default.

The local implementation does not expose `BREAK_GLASS`. Managers can see a patient/request only when the request's requesting department or an item's executor department matches their own or explicitly managed departments; request views redact items outside that department set, and queue/search/dashboard/management results are filtered at item scope.

## 5. Sensitive actions

Require confirmation/reason and server version: release, amend, void, cancel after receipt/start, reject sample, override duplicate, notification acknowledgement (including critical), role/config change, user provisioning/deactivation, export and deletion/archive. Notification acknowledgement requires `expectedVersion`, a non-empty reason, explicit `confirm: true` and an idempotency key. User provisioning, role changes and deactivation additionally require recent password reauthentication; deactivation revokes sessions and preserves the user/audit record. Do not put a confirmation modal on harmless navigation or view actions.

## 6. Authorization failure behavior

Return `403 FORBIDDEN` when the actor is authenticated but disallowed, or `404 NOT_FOUND`/equivalent indistinguishable response when revealing resource existence would leak scope. Never return hidden patient/result metadata in error details. Every denied sensitive attempt is logged at appropriate audit/security severity without storing secrets.

## 7. Review and testing obligations

For each matrix row, test allowed actor, wrong role, wrong department, wrong patient/encounter, inactive role, expired session, concurrent state and direct API/attachment URL. Server tests are authoritative; frontend permission tests are supplementary.
