# Error model

**Knowledge status:** `DECISION` de contrato planejado; mensagens e códigos devem ser validados durante implementação/API review.

## 1. Envelope

All API errors use a stable envelope:

```json
{
  "error": {
    "code": "DIAGNOSTIC_ITEM_STATE_CONFLICT",
    "message": "O exame mudou enquanto você trabalhava. Atualize a tela para continuar.",
    "details": { "currentVersion": 4, "retryable": false },
    "correlationId": "corr_01J..."
  }
}
```

`message` is human-safe and localized where appropriate; `details` is allowlisted and never contains secrets, raw SQL, stack traces, hidden patient data or storage keys.

## 2. Codes and status mapping

| Code family | HTTP | Meaning / UI recovery |
| --- | --- | --- |
| `VALIDATION_ERROR`, `INVALID_ENUM`, `INVALID_FILE` | 400 | correct fields; no state change |
| `UNAUTHENTICATED`, `SESSION_EXPIRED` | 401 | login/renew session |
| `FORBIDDEN`, `SCOPE_DENIED` | 403 | explain lack of permission without leaking resource |
| `NOT_FOUND` | 404 | verify link/scope; do not reveal hidden existence |
| `DUPLICATE_WARNING` | 409 or 200 decision response | show existing context; explicit authorized override |
| `CONFLICT`, `STALE_VERSION`, `IDEMPOTENCY_KEY_REUSED` | 409 | reload/resolve or reuse same payload |
| `INVALID_STATE_TRANSITION` | 409 | show current status and allowed next action |
| `ACCESSION_MISMATCH` | 409 | the code read is not the expected sample's; read the right label |
| `ACCESSION_INVALID` | 400 | wrong check character in a generated accession; read the label again or type the code |
| `ENCOUNTER_ALREADY_OPEN` | 409 | the patient already has an open encounter; close it before opening another |
| `ENCOUNTER_CLOSED` | 409 | the encounter is closed; open a new encounter to request exams |
| `RESULT_RELEASE_BLOCKED`, `CRITICAL_POLICY_MISSING` | 422 | fix content/config; never fake release |
| `RATE_LIMITED` | 429 | wait/backoff; include Retry-After |
| `DEPENDENCY_UNAVAILABLE`, `STORAGE_UNAVAILABLE` | 503 | retry safe operation, show degraded state |
| `INTERNAL_ERROR` | 500 | correlation ID; no sensitive detail |

## 3. Validation contract

Backend validates all external data: body/query/path schema, length, enum, format, ownership, file metadata and cross-field rules. Frontend validation improves speed only. Unknown fields are rejected or stripped by explicit policy; never pass arbitrary metadata into audit/result content.

## 4. Retry rules

Retryable: transient 503, network timeout before response, outbox delivery.  
Not automatically retryable: 400, 401, 403, 404, 409 state/conflict, 422 clinical validation.  
Commands with idempotency key may be retried; otherwise UI must show “estado desconhecido” and offer safe refresh, not duplicate blindly.

## 5. Logging

Server logs record internal error class, correlation ID, request route, latency and actor/resource IDs under access control. Client receives correlation ID for support. No empty catches, silent fallback or swallowed domain errors.
