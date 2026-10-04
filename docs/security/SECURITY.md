# Security and privacy baseline

**Knowledge status:** `DECISION/BASELINE` de segurança; não constitui evidência de controles implementados nem parecer jurídico LGPD.

**Reconciliação com o código em 01/10/2026 (AUD-012/AUD-011):** as seções 3 e 5 abaixo descrevem o que existe no repositório nesta data. Onde uma prática de referência não está implementada, ela é declarada como ausente ou como decisão pendente em vez de listada como controle.

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
- Hashing de senha local: **scrypt** com salt aleatório de 16 bytes por senha, derivada de 64 bytes e comparação em tempo constante (`src/server/security/password.ts`). O código não usa Argon2id; esta linha corrigiu a divergência doc × código apontada na auditoria de 01/10/2026, que registrava a afirmação “Argon2id” no documento.
- Política de senha implementada hoje: 12–200 caracteres na criação/definição; não existe política de complexidade nem rotação forçada.
- Throttling de força bruta: rate limit de janela fixa — 10 tentativas de `login` por 60 s, em dois buckets: um por endereço de cliente identificável e um **por par (e-mail, cliente)** (`login-account:<par normalizado em JSON>`), em `src/app/api/v1/[...path]/route.ts`. O orçamento por e-mail isolado foi removido (achado F-04): ele permitia a um terceiro bloquear de propósito o login de um usuário conhecido a partir de outra origem. Em produção o backend é PostgreSQL (`src/server/security/rate-limit.ts`) e indisponibilidade do backend falha fechado; modo `memory` é recusado em produção.
- **Backoff progressivo por par (e-mail, cliente), alimentado somente por senha errada** (`D-021`): cada senha incorreta incrementa um contador que decai em 15 min e amplia a janela do par em 2x a cada cinco erros, até 16x (teto de 1 h). Falhas de outro cliente não afetam a janela do dono. No PostgreSQL, ler o contador faz somente `SELECT`; credenciais válidas fazem `DELETE` apenas das falhas do par, preservando o orçamento de tentativas. O reset ocorre após revalidação das credenciais e antes de criar a sessão; erro de reset aborta o login sem sessão órfã. A janela inicial do contador expira em 15 min, sem renovação por leitura. Sem identidade de cliente, o limitador rejeita a operação, e a borda de produção exige identificação pelo proxy confiável; em desenvolvimento, a borda usa explicitamente `local`. Não existe fluxo público ou comando de redefinição de senha neste manifesto; conta esquecida depende de intervenção administrativa, sem infraestrutura de e-mail. Lockout permanece registrado como decisão pendente em [`THREAT_MODEL.md`](THREAT_MODEL.md) (THR-004) e a decisão de escopo está em [`../DECISION_LOG.md`](../DECISION_LOG.md).
- Session cookie: opaco, `HttpOnly`, `SameSite=Lax`, `Secure` em produção, com expiração absoluta de 8 h, expiração por inatividade de 30 min (`SESSION_IDLE_TIMEOUT_MS`) e revogação server-side; o servidor persiste apenas o hash SHA-256 do token.
- A vivacidade da sessão fica na tabela `session_activity`, fora do snapshot JSONB (`D-018`): uma requisição autenticada faz uma leitura agregada, uma leitura de linha indexada e, no máximo a cada `SESSION_ACTIVITY_TOUCH_INTERVAL_MS`, um UPSERT de linha única com `GREATEST`, que preserva a atividade mais recente em atualizações atrasadas. Sessão nova e atividade inicial são gravadas na mesma transação; erro de atividade desfaz a criação da sessão. Gravar atividade no snapshot transformava toda leitura autenticada em escrita global sobre a linha única de estado. Um stream SSE recebendo eventos ou heartbeats renova a atividade, mesmo sem interação manual; sem requisições autenticadas nem payloads SSE, aplica-se o timeout de inatividade. A expiração absoluta de 8 h continua valendo.
- No JWT/token in localStorage; no secrets in client bundle, repository or logs.
- Re-auth/step-up: `POST /session/reauth` renova a autenticação privilegiada e a janela vale 10 minutos. O step-up está ligado somente à gestão de usuários (`createUser`, `updateUserRole`, `deactivateUser`). O manifesto não possui operações de export nem de break-glass, portanto não há step-up — nem operação — correspondente.
- Logout revokes session; role changes invalidate active sessions or force re-evaluation.

## 4. Authorization

Use [`../spec/PERMISSIONS.md`](../spec/PERMISSIONS.md) as the action matrix. Enforce at controller/application/domain and attachment download. Test direct API calls, guessed IDs, wrong department, stale roles and hidden-resource enumeration.


## 5. Input/output protection

- Schema validation for every API boundary, length limits and allowlisted enums.
- Parameterized SQL/query builder; no concatenated filters.
- Encode/sanitize user text when rendered; safe Markdown/HTML policy or plain text for notes.
- CSRF protection when cookie-authenticated (CSRF token duplo por operação, validado no servidor). Não há allowlist CORS emitida: a aplicação não devolve `Access-Control-Allow-*`, ou seja, o mesmo origin é aceito por omissão e qualquer origin de terceiro fica sem permissão. Em produção são emitidos `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` e `Permissions-Policy`, e a partir desta onda (AUD-009) também `Strict-Transport-Security` (HSTS), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` e `X-Permitted-Cross-Domain-Policies`; HSTS pressupõe TLS terminado na borda (reverse proxy) e só pode ser ativado nessa topologia.
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
