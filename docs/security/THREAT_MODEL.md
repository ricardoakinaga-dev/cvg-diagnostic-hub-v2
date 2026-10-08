# Threat model

**Knowledge status:** `ASSUMPTION` de ameaça inicial + `DECISION` de mitigação proposta; workshop com TI/clinical owner ainda é `OPEN QUESTION`. A revisão adversarial local de 07/09/2026 está em [`ADVERSARIAL_REVIEW_2026-09-07.md`](ADVERSARIAL_REVIEW_2026-09-07.md) e continua `REVIEW_REQUIRED`.

Method: trust boundaries + abuse cases, with mitigation and verification. Severity is preliminary until threat workshop with TI/clinical owner.

| ID | Threat/asset | Vector | Impact | Controls | Verification |
| --- | --- | --- | --- | --- | --- |
| THR-001 | Unauthorized result access | guessed request/result/attachment ID (IDOR) | confidentiality/clinical harm | opaque IDs, resource/scope auth, safe 404 | integration security tests |
| THR-002 | Privilege escalation | client modifies role/department/actor fields | integrity | server derives actor; admin-only role commands; audit | negative API tests |
| THR-003 | Session theft/fixation | cookie/token exposure | account takeover | secure cookie, TLS, rotation, revocation, headers | session tests/pen test |
| THR-004 | Brute force | login/search/reconnect flood | availability/access | rate limit de janela fixa (60 s) em bucket por endereço de cliente e bucket por credencial de login, com backend PostgreSQL obrigatório em produção e falha fechado na indisponibilidade; alerta é decisão de D-05. backoff progressivo por par (e-mail, cliente) para senha errada (D-021) e **sinal agregado por conta sem bloqueio** (`security.login_distributed_attempts`, PROD-203/PROD-517). **Lockout por conta foi rejeitado** (D-021, D-039): permitiria a um atacante trancar o dono da conta para fora | load/abuse test |
| THR-005 | Malicious upload | MIME spoof, executable/polyglot, oversized file | RCE/data loss | allowlist, sniff, limit, quarantine/scan, private storage | upload corpus tests |
| THR-006 | XSS/injection | note/result/service text | session/clinical display | output encoding, schema, CSP, parameterized SQL | XSS/SQLi tests |
| THR-007 | Audit manipulation | privileged update/delete | loss of accountability | append-only table, restricted access, compensating events | audit tamper test |
| THR-008 | Result misassociation | homonym, wrong sample, external ID collision | clinical harm | patient bundle, encounter constraints, accession chain, confirmation | workflow/E2E tests |
| THR-009 | Critical notification loss | worker/channel failure or wrong recipient | clinical harm | outbox, retry, ack/escalation, critical queue | failure injection/drill |
| THR-010 | Replay/double command | retry/double-click | duplicate release/recollection | idempotency + version constraints | repeated/concurrent tests |
| THR-011 | Data leakage in logs/URLs | full result/token/storage key | privacy | redaction, opaque IDs, signed URLs, log review | static/runtime scan |
| THR-012 | Backup compromise | exposed bucket/dump | broad disclosure | encryption, IAM, retention, key management, restore isolation | access review |
| THR-013 | Ransomware/deletion | compromised app/admin/storage | availability/integrity | least privilege, immutable/offline backup, restore runbook | tabletop/restore drill |
| THR-014 | Stale realtime | client treats event as truth | wrong action | version/refetch, degraded banner | network/reconnect E2E |
| THR-015 | External integration spoof | unsigned import/webhook | false result/status | signature, provenance, idempotency, quarantine | contract tests |
| THR-016 | Scanner SSRF/redirect | endpoint points to an unapproved, private or redirecting host | secret exfiltration/internal reachability | exact `MALWARE_SCANNER_ALLOWED_HOSTS` allowlist, HTTPS in production, IP approval, URL component validation, `redirect: error` | scanner boundary tests; target egress test |
| THR-017 | Secrets lifecycle failure | scanner/storage credentials in process environment or stale secret | credential exposure/service compromise | fail-closed required keys, redacted errors, approved secrets manager and rotation policy | local configuration tests; target secret review |
| THR-018 | Supply-chain compromise | malicious dependency, compromised build or unverified artifact | code execution/data compromise | lockfile, `npm audit`, CI pinning, secret scan and CycloneDX SBOM artifact | local scans/SBOM; provenance, dependency policy and pentest |
| THR-019 | Password reset token abuse | guessed, leaked, replayed or intercepted reset link; oracle on token state; stolen cookie surviving a reset | account takeover | token de 256 bits (32 bytes aleatórios), **só a impressão digital (scrypt com `SESSION_SECRET` como sal) é armazenada** e nunca vai à auditoria, ao log nem ao replay idempotente; uso único (apagado na mesma transação que grava a senha); validade curta (`PASSWORD_RESET_TTL_MS`, 5 min–24 h) e um único link ativo por conta; emissão só por quem tem `user_role.manage` no escopo do alvo, com step-up para ADMIN e auditoria; conclusão pública com orçamento de 10 tentativas por cliente a cada 15 min, comparação em tempo constante e política de senha completa; **sem oráculo**: token inexistente, expirado, já usado ou de conta desativada respondem o mesmo `400 PASSWORD_RESET_INVALID` (só a auditoria distingue); todas as sessões do alvo são revogadas na emissão e na conclusão e o endpoint público **não cria sessão**; a página remove o token da barra de endereço; o link é entregue pelo ADMIN por um canal do hospital (risco residual: o canal) | `password-reset.test.ts`, `password-reset-link.test.ts`, `route.test.ts` |

## Abuse cases to exercise

1. user changes `actorId`, `departmentId`, `patientId` or role in request body;
2. user opens another department’s result/attachment by copied URL;
3. attacker uploads valid-looking executable, oversized file and malformed image/PDF;
4. user repeats release/recollection with same/different payload;
5. attacker searches wildcard/SQL/XSS payloads or enumerates protocol codes;
6. worker crashes after commit and before delivery;
7. two users review/amend the same version;
8. expired/disabled user keeps SSE connection.
9. scanner endpoint is changed to loopback/private IP, unapproved hostname or a redirect target;
10. scanner API key is exposed through configuration, logs, dependency output or a build artifact.

## Residual risk

Critical-value policy, retention, identity provider, network segmentation and real load are not yet validated. Threat model must be revisited after OQ decisions and before production.
