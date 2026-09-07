# Security and privacy baseline

**Knowledge status:** `DECISION/BASELINE` de segurança; não constitui evidência de controles implementados nem parecer jurídico LGPD.

## 1. Scope and posture

O Hub tratará dados pessoais de tutores e profissionais e dados clínicos vinculados a pacientes animais. A aplicabilidade concreta da LGPD, bases legais, controlador/operador, retenção e direitos deve ser validada pelo responsável institucional; esta documentação não substitui parecer jurídico.

Security must protect clinical correctness, confidentiality, integrity and availability. “Funcionou no happy path” is not a security gate.

## 2. Trust boundaries

```text
Browser/untrusted input
  → HTTPS reverse proxy
  → authenticated API/session
  → module authorization/domain
  → PostgreSQL / object storage
  → outbox/integrations
```

Every boundary validates input, actor, resource and output. External integrations are untrusted until signature/idempotency/provenance checks pass.

## 3. Authentication/session

- Prefer hospital OIDC/AD when validated; keep an `IdentityProvider` boundary.
- If local credentials are needed for pilot: Argon2id password hashing, password policy, brute-force throttling, reset process and no plaintext secrets.
- Session cookie: opaque, HttpOnly, Secure, SameSite appropriate to deployment, bounded expiry and server-side revocation.
- No JWT/token in localStorage; no secrets in client bundle, repository or logs.
- Re-auth/step-up for role changes, export, break-glass and sensitive configuration.
- Logout revokes session; role changes invalidate active sessions or force re-evaluation.

## 4. Authorization

Use [`../spec/PERMISSIONS.md`](../spec/PERMISSIONS.md) as the action matrix. Enforce at controller/application/domain and attachment download. Test direct API calls, guessed IDs, wrong department, stale roles and hidden-resource enumeration.

## 5. Input/output protection

- Schema validation for every API boundary, length limits and allowlisted enums.
- Parameterized SQL/query builder; no concatenated filters.
- Encode/sanitize user text when rendered; safe Markdown/HTML policy or plain text for notes.
- CSRF protection when cookie-authenticated; CORS allowlist, security headers, TLS and HSTS in production.
- Redirects/URLs allowlisted; no open redirect.
- Rate limit login, search, upload, command retries and SSE reconnect.
- Error responses use safe codes/correlation ID, never stack traces or hidden resource facts.

## 6. Upload security

- Accept only approved extensions and detected MIME; do not trust client MIME.
- Size/count limits, filename normalization, random storage key, checksum.
- Store private; use short-lived authorized URLs.
- Quarantine until malware scan/validation succeeds; reject polyglot/executable content.
- Do not parse/render untrusted PDF/image inline without safe headers/sandbox policy.
- Audit uploader, version, scan result and download access according to privacy policy.

## 7. Data protection/LGPD worklist

- inventory personal fields and purpose;
- minimize tutor/professional contact fields and avoid sensitive data in metrics/logs;
- role-based access and need-to-know scopes;
- retention/archive/export/deletion policy approved before jobs are enabled;
- incident response and data breach notification contacts;
- vendor/storage agreements and encryption at rest/in transit;
- data subject workflow where legally applicable.

OQ-013 is a release gate. Do not claim “LGPD compliant” from this document alone.

## 8. Audit and integrity

Audit result release/amend/void/review, sample rejection/recollection, permission/config changes, critical acknowledgement, export, break-glass and denied sensitive attempts. Audit events are append-only for ordinary users, timestamped by server, correlated and access-controlled. Admin corrections append a compensating event; never rewrite history.

## 9. Secrets and supply chain

- environment/secret manager per environment;
- no real data in fixtures, logs or screenshots;
- dependency lockfile and vulnerability review in CI when code exists;
- pinned/reviewed images, least-privileged containers and non-root process where feasible;
- rotate credentials and document emergency revocation.

## 10. Evidence and security gates

The executable negative-control inventory is [`KNOWN_BAD_CONTROL_MATRIX.md`](KNOWN_BAD_CONTROL_MATRIX.md); the current adversarial supplement is [`ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md`](ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md). These artifacts report local evidence and residual gates; neither is a pentest, legal opinion or production approval.

Before pilot: threat-model review, dependency scan, auth/RBAC/IDOR tests, upload abuse tests, SQLi/XSS/CSRF checks, header/TLS review, audit verification, backup encryption/restore and incident/runbook rehearsal.
