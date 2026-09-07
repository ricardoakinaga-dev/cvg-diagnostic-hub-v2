# Revisão adversarial de segurança — 07/09/2026

**Classificação:** `REVIEW_REQUIRED` · revisão local automatizada e por inspeção de código; não é pentest independente, aprovação institucional ou aceite clínico.

**Escopo:** ameaça, abuso e controles executáveis do candidato local AAA-3. O pacote liga cada conclusão a um arquivo de teste ou comando atual. Evidência sintética não é promovida a evidência de produção.

## Resultado

Os controles de sessão, autorização por escopo, IDOR, concorrência/versionamento, upload privado, outbox, realtime, rate limit distribuído e recuperação possuem regressões executáveis. O rate limit PostgreSQL foi reforçado nesta rodada com quota concorrente de 12 chamadas, limite de 3 concessões, reset de janela e fail-fast para URL/pool inválidos. O scanner externo agora exige allowlist exata de host, rejeita componentes perigosos/IPs não aprovados e não segue redirects; o realtime restringe replay a mensagens `PENDING` ou `PROCESSED` e suprime `PROCESSING`/`FAILED`.

O resultado permanece `CONDITIONAL`: não há prova de IdP institucional, TLS/segmentação, storage/antimalware real, carga representativa, scanner de abuso, restore completo, revisão humana de ameaça ou aprovação clínica.

## Matriz de controles

| ID | Ameaça | Estado local | Evidência executável | Limitação restante |
| --- | --- | --- | --- | --- |
| THR-001 | IDOR em paciente, request, resultado e anexo | `OBSERVED` | `src/server/security/authorization.test.ts`; `src/server/http/scoped-reads-route.test.ts`; `src/server/application/result-access-security.test.ts` | Pentest e matriz institucional de recursos ainda não executados. |
| THR-002 | Elevação por `actorId`, role, setor ou escopo enviado pelo cliente | `OBSERVED` | `src/server/security/authorization.test.ts`; `src/server/application/management.test.ts`; `src/server/http/admission-context-route.test.ts` | Revisão adversarial independente continua pendente. |
| THR-003 | Sessão roubada, fixação ou revogação atrasada | `PARTIAL` | `src/server/security/session.test.ts`; `tests/postgres/postgres-store.integration.test.ts` | IdP, TLS, rotação operacional e exercício multi-instância alvo não foram aprovados. |
| THR-004 | Brute force e abuso de API | `PARTIAL` | `src/server/security/rate-limit.test.ts`; `tests/postgres/postgres-store.integration.test.ts` (bucket PostgreSQL concorrente) | Volume real, alertas, operação de outage e tuning hospitalar não foram medidos. |
| THR-005 | MIME spoof, traversal, checksum, arquivo oversized ou quarentena | `PARTIAL` | `src/server/storage/file-store.test.ts`; `src/server/storage/s3-file-store.test.ts`; `src/server/application/attachments.test.ts`; `src/server/storage/malware-scanner.test.ts` | Scanner AV externo, corpus real/polyglot e storage aprovado ainda não foram homologados. |
| THR-006 | XSS, SQL injection e conteúdo não escapado | `PARTIAL` | `src/server/http/request-body.test.ts`; `src/server/http/command-schemas.test.ts`; queries parametrizadas no store | Fuzzing/pentest externo e CSP/TLS no ambiente alvo continuam pendentes. |
| THR-007 | Alteração ou remoção de auditoria | `OBSERVED` | `src/server/store/migrations.test.ts`; `tests/postgres/postgres-store.integration.test.ts` (append-only/TRUNCATE) | Imutabilidade operacional, retenção e acesso de DBA precisam de revisão institucional. |
| THR-008 | Associação incorreta de paciente, atendimento, amostra ou accession | `PARTIAL` | `src/server/application/service.test.ts`; `src/server/store/relational/sample-lineage.test.ts`; `tests/postgres/relational-sample-lineage.integration.test.ts` | Política de homônimo/ownership/transferência ainda é D-01 aberta. |
| THR-009 | Perda ou destinatário errado de notificação crítica | `PARTIAL` | `src/server/application/critical-result-policy.test.ts`; `src/server/operations/outbox.test.ts`; `tests/postgres/postgres-store.integration.test.ts` | Plantão, fallback, escalonamento temporal e canal redundante dependem de D-03. |
| THR-010 | Replay, double-submit e concorrência de comando | `OBSERVED` | `src/server/application/service.test.ts`; `src/server/application/attachments.test.ts`; `src/server/application/workflow-commands.test.ts`; `src/server/application/result-access-security.test.ts` | Inventário humano de todos os comandos e revisão independente ainda necessários. |
| THR-011 | Vazamento em logs, URLs, storage key ou resposta | `PARTIAL` | `src/server/operations/recovery-manifest.test.ts`; `src/server/http/openapi-runtime-response.test.ts`; `npm run security:scan` | Revisão de observabilidade/retenção e logs do ambiente alvo não executada. |
| THR-012 | Compromisso de dump, bucket ou chave | `NOT_RUN` | `src/server/operations/recovery-manifest.test.ts` valida referências sem segredos | Criptografia, IAM, KMS, residência e acesso de backup reais são D-05. |
| THR-013 | Ransomware, exclusão ou falha ampla de recuperação | `PARTIAL` | `npm run test:recovery`; `npm run db:restore:smoke` local PostgreSQL-only | Restore de objetos/configuração/chaves, RPO/RTO e operador independente não foram provados. |
| THR-014 | Realtime stale tratado como verdade clínica | `OBSERVED` | `src/server/observability/realtime.test.ts`; `src/server/observability/realtime-stream.test.ts`; `tests/postgres/realtime-listen.integration.test.ts`; browser sem retry | Eventos em processamento/falha são suprimidos localmente; failover, cliente lento e comportamento sob carga no ambiente alvo continuam abertos. |
| THR-015 | Integração externa falsificada | `NOT_RUN` | Contratos locais cobrem adapters, não uma integração externa assinada | IdP/PACS/scanner/webhook reais, assinatura, rotação e quarentena precisam de contrato aprovado. |
| THR-016 | SSRF/redirect no scanner externo | `OBSERVED` | `src/server/storage/malware-scanner.test.ts` valida allowlist exata, IP não aprovado, URL sem credenciais/fragmento e `redirect: error` | DNS rebinding, egress firewall, resolução privada/link-local e scanner real não foram testados no ambiente alvo. |
| THR-017 | Segredos e rotação | `NOT_RUN` | Factory falha fechada quando endpoint/key/allowlist faltam; erros não imprimem a chave | Secrets manager, rotação, KMS, acesso de operador e varredura de artefatos do ambiente alvo permanecem ausentes. |
| THR-018 | Supply chain/build | `PARTIAL` | `npm audit --audit-level=high`; lockfile; `npm run security:scan`; `npm ci`/typecheck/build locais; SBOM CycloneDX 1.5 com 560 componentes sob Node 22 | assinatura/proveniência, dependabot policy, CI remoto e pentest ainda não foram aprovados. |

## Abusos negativos executados

- tentativa de ampliar setor/paciente/serviço por metadado opcional ou payload;
- leitura de recurso fora do escopo com resposta 404 escopada;
- replay após revogação de departamento delegado;
- emenda/void/release por executor não proprietário;
- sessão de upload com traversal, checksum/tamanho divergente, claim concorrente, expiração e quarentena;
- duas chamadas concorrentes para o mesmo limite PostgreSQL, com no máximo três concessões;
- falha do backend compartilhado de rate limit retornando `503 DEPENDENCY_UNAVAILABLE`;
- tentativa de truncar a projeção de auditoria;
- alteração concorrente de versão, claim de outbox, replay SSE e restore para destino não isolado.
- apontamento do scanner externo para loopback/private IP, hostname fora da allowlist, URL com credenciais/fragmento ou redirect;
- tentativa de marcar `PROCESSING`/`FAILED` como evento realtime entregue;
- exposição de chave do scanner em resposta, log, manifest ou artefato de build.

## Próximas condições de aceite

1. Realizar workshop independente com segurança, TI e responsável clínico; revisar severidade, ativos, trust boundaries e proprietários.
2. Executar SAA-041/SAA-042 no ambiente alvo com IdP, TLS, storage, scanner, secrets e logs reais ou aprovados.
3. Executar SAA-046/SAA-047 com workload, failover, restore completo, RPO/RTO e operador independente.
4. Reabrir esta matriz depois de D-01–D-05 e anexar o parecer externo; este documento sozinho não fecha SAA-048 nem SAA-056.
5. Completar SAA-048 com egress controlado, secrets manager, proveniência assinada, pentest e revisão independente; o SBOM local está disponível, mas os controles desta rodada permanecem `REVIEW_REQUIRED`.
