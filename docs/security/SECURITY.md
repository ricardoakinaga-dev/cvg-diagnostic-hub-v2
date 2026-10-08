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
- Política de senha: 12–200 caracteres, com letras e números na definição. A administração gera uma senha inicial aleatória no servidor, exibida uma única vez e nunca persistida em claro. Usuários novos devem substituí-la no primeiro acesso (`POST /session/password`); antes disso, o servidor permite apenas consultar a própria identidade, trocar a senha e sair. A substituição grava o hash, revoga as sessões anteriores, emite novos tokens de sessão/CSRF e registra auditoria na mesma transação. A política de autorização de realtime também rejeita senhas temporárias. Depois disso, o próprio usuário troca a senha em `POST /session/password/change` (PROD-201, D-031): exige a senha atual, verificada com scrypt fora da transação, com no máximo 5 tentativas por conta a cada 15 min e erro `CURRENT_PASSWORD_INVALID`; a nova senha segue a mesma política e precisa ser diferente; a troca revoga todas as sessões do usuário, emite nova sessão e registra `PasswordChanged` sem segredo. Repetir a criação com a mesma chave de idempotência não reexibe a senha.
- Throttling de força bruta: rate limit de janela fixa — 10 tentativas de `login` por 60 s, em dois buckets: um por endereço de cliente identificável e um **por par (e-mail, cliente)** (`login-account:<par normalizado em JSON>`), em `src/app/api/v1/[...path]/route.ts`. O orçamento por e-mail isolado foi removido (achado F-04): ele permitia a um terceiro bloquear de propósito o login de um usuário conhecido a partir de outra origem. Em produção o backend é PostgreSQL (`src/server/security/rate-limit.ts`) e indisponibilidade do backend falha fechado; modo `memory` é recusado em produção.
- **Backoff progressivo por par (e-mail, cliente), alimentado somente por senha errada** (`D-021`): cada senha incorreta incrementa um contador que decai em 15 min e amplia a janela do par em 2x a cada cinco erros, até 16x (teto de 1 h). Falhas de outro cliente não afetam a janela do dono. No PostgreSQL, ler o contador faz somente `SELECT`; credenciais válidas fazem `DELETE` apenas das falhas do par, preservando o orçamento de tentativas. O reset ocorre após revalidação das credenciais e antes de criar a sessão; erro de reset aborta o login sem sessão órfã. A janela inicial do contador expira em 15 min, sem renovação por leitura. Sem identidade de cliente, o limitador rejeita a operação, e a borda de produção exige identificação pelo proxy confiável; em desenvolvimento, a borda usa explicitamente `local`. A recuperação administrativa usa `POST /users/{userId}/password`, com autorização pelo perfil e setor atuais, CSRF, limite de requisições, versão esperada e idempotência. O servidor gera uma senha temporária, revoga as sessões e registra auditoria na mesma transação; a senha aparece só na primeira resposta, não no estado, na auditoria ou no replay. A troca é obrigatória no próximo acesso. Contas desativadas e a própria conta não podem ser recuperadas por esse comando. Não há recuperação pública por e-mail. Lockout permanece registrado como decisão pendente em [`THREAT_MODEL.md`](THREAT_MODEL.md) (THR-004) e a decisão de escopo está em [`../DECISION_LOG.md`](../DECISION_LOG.md).
- Session cookie: opaco, `HttpOnly`, `SameSite=Lax`, `Secure` em produção, com expiração absoluta de 8 h, expiração por inatividade de 30 min (`SESSION_IDLE_TIMEOUT_MS`) e revogação server-side; o servidor persiste apenas o hash SHA-256 do token.
- A vivacidade da sessão fica na tabela `session_activity`, fora do snapshot JSONB (`D-018`): uma requisição autenticada faz uma leitura agregada, uma leitura de linha indexada e, no máximo a cada `SESSION_ACTIVITY_TOUCH_INTERVAL_MS`, um UPSERT de linha única com `GREATEST`, que preserva a atividade mais recente em atualizações atrasadas. Sessão nova e atividade inicial são gravadas na mesma transação; erro de atividade desfaz a criação da sessão. Gravar atividade no snapshot transformava toda leitura autenticada em escrita global sobre a linha única de estado. Um stream SSE recebendo eventos ou heartbeats renova a atividade, mesmo sem interação manual; sem requisições autenticadas nem payloads SSE, aplica-se o timeout de inatividade. A expiração absoluta de 8 h continua valendo.
- No JWT/token in localStorage; no secrets in client bundle, repository or logs.
- Re-auth/step-up: `POST /session/reauth` renova a autenticação privilegiada e a janela vale 10 minutos. O step-up é obrigatório para conceder ou remover acesso ADMIN, inclusive criação e desativação desse perfil, e para regenerar a credencial de outra conta ADMIN; sua evidência vem exclusivamente da sessão persistida, nunca de um timestamp fornecido pelo ator. As demais alterações administrativas não pedem senha, motivo ou checkbox; autorização por perfil/setor, CSRF, rate limit, controle de versão e auditoria continuam no servidor. Motivos permanecem obrigatórios nos comandos clínicos de recoleta, cancelamento, rejeição e emenda. Sessões, dead-letter e auditoria aparecem na aba Sistema, visível apenas para ADMIN; as APIs de listar/revogar sessões também exigem ADMIN. Revogar sessão e operar dead-letter usam confirmação simples na interface. A autorização de dead-letter é revalidada dentro da transação da alteração, inclusive em replay idempotente. O manifesto não possui operações de export nem de break-glass, portanto não há step-up — nem operação — correspondente.
- Logout revokes session; role changes invalidate active sessions or force re-evaluation.

## 4. Authorization

Use [`../spec/PERMISSIONS.md`](../spec/PERMISSIONS.md) as the action matrix. Enforce at controller/application/domain and attachment download. Test direct API calls, guessed IDs, wrong department, stale roles and hidden-resource enumeration.

As equipes executoras continuam limitadas ao setor e à lista explícita de exames (`serviceCodes`). A administração atribui essa lista nas opções recolhidas de “Exames autorizados”; o servidor rejeita códigos desconhecidos ou de outro setor, registra as mudanças e revoga as sessões anteriores. Trocar o setor remove os exames do setor anterior. Duplicar um painel numérico copia somente o template persistido de um serviço autorizado, mantendo a exigência de template ativo e versionado.

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

Alert number (PROD-402): the WhatsApp number for critical-result alerts is a professional's personal data. Only the person registers it, in **Minha conta**, with explicit consent recorded with a timestamp; they can remove it at any time, which erases both fields. Administrators see only whether a number exists. Responses return it masked, and audit events, logs and metrics never carry it. Messages carry no clinical data, only the protocol and the Hub link.

Critical escalation (PROD-402) widens access on purpose. When an unacknowledged critical result reaches an on-call or responsible veterinarian or inpatient-team member, that professional receives the patient in their scope, so they can open and acknowledge the result. Each grant is audited as `CriticalEscalationPatientAccessGranted`, with the patient and the notification. Managers rely on their delegated departments. Administrators and viewers are never escalation recipients.

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
