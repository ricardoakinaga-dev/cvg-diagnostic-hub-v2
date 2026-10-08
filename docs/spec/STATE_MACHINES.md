# State machines

**Knowledge status:** `DECISION` de comportamento proposta; a semântica clínica final de revisão, crítico, cancelamento e SLA depende das `OPEN QUESTIONS` referenciadas.

Os diagramas são normativos junto às tabelas de transição. `actor` significa role + escopo, não apenas uma tela que mostra um botão.

## 0. Normalization of supplied labels

The briefing’s candidate labels are intentionally normalized here: `PENDING` is an operational view over `REQUESTED`/`SCHEDULED`/exception states, not a second persisted item state; `RESULT_AVAILABLE` means a result version was released, not merely drafted; `REVIEWED` is distinct from `Viewed` and critical `Acknowledged`; `FAILED` is recoverable until an explicit terminal decision. This avoids a single ambiguous enum carrying lifecycle, SLA and communication semantics.

## 1. DiagnosticRequest aggregate

O status da request é derivado:

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> IN_PROGRESS: item_started_or_received
  IN_PROGRESS --> PARTIALLY_AVAILABLE: item_result_released_and_active_items_remain
  IN_PROGRESS --> RESULTS_AVAILABLE: all_results_released_but_review_pending
  IN_PROGRESS --> COMPLETED: all_items_terminal_and_one_completed
  IN_PROGRESS --> CANCELLED: all_items_cancelled_or_rejected
  PARTIALLY_AVAILABLE --> RESULTS_AVAILABLE: remaining_active_items_released
  PARTIALLY_AVAILABLE --> COMPLETED: remaining_items_terminal
  RESULTS_AVAILABLE --> COMPLETED: all_result_versions_reviewed_and_policy_satisfied
  PARTIALLY_AVAILABLE --> IN_PROGRESS: amendment_requires_rework
  COMPLETED --> PARTIALLY_AVAILABLE: released_result_amended
  REQUESTED --> CANCELLED: all_eligible_items_cancelled
```

Não há `request.completed` manual que ignore itens. `MIXED_TERMINAL` pode ser um filtro/summary, não um estado persistido.

## 2. DiagnosticRequestItem

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> RECEIVED: sample_received [LAB]
  REQUESTED --> SCHEDULED: schedule_created [requires_schedule]
  REQUESTED --> IN_PROGRESS: start_without_sample [workflow_allows]
  SCHEDULED --> IN_PROGRESS: procedure_started
  SCHEDULED --> SCHEDULED: reschedule [reason]
  SCHEDULED --> CANCELLED: cancel [authorized_before_start]
  RECEIVED --> IN_PROGRESS: processing_started
  IN_PROGRESS --> AWAITING_REPORT: exam_performed [IMAGING]
  IN_PROGRESS --> RESULT_AVAILABLE: result_released [LAB_direct]
  AWAITING_REPORT --> RESULT_AVAILABLE: report_released
  RECEIVED --> RECOLLECTION_REQUIRED: sample_rejected
  IN_PROGRESS --> RECOLLECTION_REQUIRED: sample_problem
  RECOLLECTION_REQUIRED --> RECEIVED: replacement_sample_received
  REQUESTED --> REJECTED: reject [authorized]
  RECEIVED --> REJECTED: reject [authorized]
  REQUESTED --> CANCELLED: cancel [authorized]
  RECEIVED --> CANCELLED: cancel [elevated]
  IN_PROGRESS --> CANCELLED: cancel [elevated_and_policy]
  AWAITING_REPORT --> CANCELLED: cancel [elevated_policy]
  RECOLLECTION_REQUIRED --> CANCELLED: cancel [authorized_before_replacement]
  FAILED --> CANCELLED: cancel [manager_policy]
  IN_PROGRESS --> FAILED: execution_failed [reason]
  FAILED --> RECEIVED: recover [LAB]
  FAILED --> REQUESTED: recover [workflow]
  RESULT_AVAILABLE --> REVIEWED: review_current_version
  REVIEWED --> COMPLETED: complete [completion_policy]
  RESULT_AVAILABLE --> RESULT_VOIDED: void [approved_reason]
  REVIEWED --> RESULT_VOIDED: void [approved_reason]
  COMPLETED --> RESULT_VOIDED: void [approved_reason_reopens]
  RESULT_VOIDED --> IN_PROGRESS: replacement_result_started
  RESULT_AVAILABLE --> RESULT_AVAILABLE: amend [new_version_needs_review]
  COMPLETED --> RESULT_AVAILABLE: amend [reopen_current_item]
```

### Transition contract

| From | Event/command | To | Actor/precondition | Side effects |
| --- | --- | --- | --- | --- |
| request→ | `DiagnosticItemRequested` | `REQUESTED` | requester; service active | audit, SLA start per policy |
| `REQUESTED` | `SampleReceived` | `RECEIVED` | LAB_TECH; sample belongs to request/patient | link sample, timestamp, audit |
| `REQUESTED` | `ProcedureScheduled` | `SCHEDULED` | image team; service requires schedule | schedule history, due_at |
| `RECEIVED/SCHEDULED` | `ProcessingStarted`/`ProcedureStarted` | `IN_PROGRESS` | executor + expected version | audit, started_at |
| `IN_PROGRESS` | `ExamPerformed` | `AWAITING_REPORT` | image team | performed_at, report task |
| `IN_PROGRESS/AWAITING_REPORT` | `ResultReleased` | `RESULT_AVAILABLE` | result owner; valid current draft/version | result version, audit/outbox |
| `RESULT_AVAILABLE` | `ResultViewed` | unchanged | scoped user | view event/record |
| `RESULT_AVAILABLE` | `ResultReviewed` | `REVIEWED` | reviewer; current version was viewed/accessible | review event |
| `REVIEWED` | `RequestItemCompleted` | `COMPLETED` | policy; required review/terminal checks | completed_at |
| `RECEIVED/IN_PROGRESS` | `RecollectionRequested` | `RECOLLECTION_REQUIRED` | lab authorized; reason | new sample intent, notification |
| `SCHEDULED/RECOLLECTION_REQUIRED/FAILED` | `CancelItem` | `CANCELLED` | stage-based permission; reason | audit, notification if needed |
| `AWAITING_REPORT` | `CancelItem` | `CANCELLED` | elevated policy; execution history retained | audit, notification |
| `RESULT_AVAILABLE/REVIEWED/COMPLETED` | `VoidResult` | `RESULT_VOIDED` | manager/result owner; approved reason; current version becomes invalid | prior version `VOIDED`, replacement required, audit + correction notification, prior review/ack remains historical |
| `RESULT_VOIDED` | `CreateReplacementResultDraft` | `IN_PROGRESS` | result owner; item has no valid current result | new draft, new release/review path, aggregate reopens |
| eligible | `RejectItem` | `REJECTED` | executor/manager; reason | audit, notification |
| active | `ExecutionFailed` | `FAILED` | executor; reason | incident/audit, recovery task |
| `RESULT_AVAILABLE/COMPLETED` | `AmendResult` | `RESULT_AVAILABLE` | result owner/manager; reason | new version, invalidate current review, re-notify |

`FAILED`, `RECOLLECTION_REQUIRED`, `SCHEDULED` e `RESULT_VOIDED` não são terminais. `COMPLETED`, `CANCELLED` e `REJECTED` são terminais normais; emenda e void são reaberturas explícitas, nunca sobrescritas silenciosas. No MVP, `ResultReviewed` grava a revisão e, quando não há pendência de acknowledgement/policy, a `CompletionPolicy` emite `RequestItemCompleted` na mesma transação; se uma policy exigir fechamento manual, o endpoint explícito de complete é usado.

## 3. Laboratory workflow

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> RECEIVED: receive_sample
  RECEIVED --> IN_PROGRESS: start_processing
  IN_PROGRESS --> RESULT_AVAILABLE: release_result
  RECEIVED --> RECOLLECTION_REQUIRED: reject_sample
  IN_PROGRESS --> RECOLLECTION_REQUIRED: sample_problem
  RECOLLECTION_REQUIRED --> RECEIVED: receive_replacement
  RESULT_AVAILABLE --> REVIEWED: review
  REVIEWED --> COMPLETED: complete
```

Motivos mínimos configuráveis: `HEMOLYZED`, `INSUFFICIENT_VOLUME`, `CLOTTED`, `MISIDENTIFIED`, `INAPPROPRIATE_MATERIAL`, `OTHER` com observação obrigatória para `OTHER`.

## 4. Imaging workflow

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> SCHEDULED: schedule [US/required]
  REQUESTED --> IN_PROGRESS: patient_forwarded [RX/no_schedule]
  SCHEDULED --> IN_PROGRESS: patient_forwarded
  SCHEDULED --> SCHEDULED: reschedule [reason]
  IN_PROGRESS --> AWAITING_REPORT: exam_performed
  AWAITING_REPORT --> RESULT_AVAILABLE: report_released
  RESULT_AVAILABLE --> REVIEWED: review
  REVIEWED --> COMPLETED: complete
```

## 5. Result lifecycle/version

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> RELEASED: release [validation+authorization]
  RELEASED --> SUPERSEDED: amend [new version committed]
  SUPERSEDED --> [*]
  RELEASED --> VOIDED: void [exception policy]
  DRAFT --> VOIDED: discard [before release, audited]
```

O logical `Result` continua apontando para a versão atual `RELEASED`; a versão anterior fica `SUPERSEDED`. Emenda em resultado revisado limpa `needs_re_review` apenas após nova revisão.

## 6. Recollection

```mermaid
stateDiagram-v2
  [*] --> EXPECTED
  EXPECTED --> RECEIVED: sample_received
  RECEIVED --> REJECTED: reject [reason]
  REJECTED --> REPLACED: recollection_requested
  REPLACED --> RECEIVED: replacement_received
  EXPECTED --> CANCELLED: cancel_item
```

Cada substituição referencia `replaces_sample_id`; não se reutiliza accession rejeitado.

**`EXPECTED` nasce na criação da solicitação (D-034).** A amostra é criada com o accession gerado e a etiqueta já pode ser impressa antes da coleta. `EXPECTED → RECEIVED` acontece no recebimento: a leitura do código de barras (ou o campo vazio) confirma a amostra esperada, grava `received_at/by` e move para `RECEIVED` todos os itens `REQUESTED` ligados ao mesmo tubo. Um código diferente do esperado recusa o comando (`409 ACCESSION_MISMATCH`) e um código gerado com dígito verificador errado recusa com `400 ACCESSION_INVALID`; nada muda. Rejeitar um exame que divide um tubo ainda `EXPECTED` apenas o desliga da amostra; rejeitar o último item rejeita a amostra. A recoleta cria a substituta `EXPECTED` já com accession gerado, para imprimir a etiqueta da nova coleta.

O vínculo entre as máquinas é explícito: `SampleRejected`/`RecollectionRequested` grava a amostra como `REJECTED`/`REPLACED` e move cada `DiagnosticRequestItem` afetado para `RECOLLECTION_REQUIRED`; `replacement_received` cria/recebe o novo sample (`EXPECTED → RECEIVED`) e move somente os itens vinculados de volta para `RECEIVED`. Uma amostra rejeitada não pode, sozinha, devolver o item ao processamento.

## 7. Critical result notification

```mermaid
stateDiagram-v2
  [*] --> NOT_CRITICAL
  NOT_CRITICAL --> DETECTED: critical_detected
  DETECTED --> NOTIFIED: notification_created
  NOTIFIED --> ACKNOWLEDGED: recipient_acknowledged
  NOTIFIED --> ESCALATED: timeout_without_ack
  ESCALATED --> ACKNOWLEDGED: fallback_acknowledged
  ACKNOWLEDGED --> CLOSED: policy_close
```

Valores, recipients e timeout são configuração aprovada; o sistema não inventa threshold clínico.
