# Plano até produção — CVG Diagnostics Hub

**Data:** 02/10/2026
**Knowledge status:** `DECISION` para a ordem das fases e os critérios de saída; `FACT` para o ponto de partida (verificado em 01–02/10/2026); `ASSUMPTION` para os tamanhos, que só viram compromisso depois das decisões da Fase 0.

[Prontidão](../operations/PRODUCTION_READINESS.md) · [Checklist de release](../operations/RELEASE_CHECKLIST.md) · [Deploy](../operations/DEPLOYMENT.md) · [Perguntas abertas](../discovery/OPEN_QUESTIONS.md) · [Backlog AUDIT-2026-10](AUDIT_2026_10_BACKLOG.md)

> **Execução:** o [roadmap](PRODUCTION_ROADMAP.md) e o [backlog PROD-2026-10](PRODUCTION_BACKLOG.md) (02/10/2026) são a fonte corrente. Cada item `P*` deste plano aponta para um item `PROD-*`. Depois da [auditoria de 02/10](../RELATORIO_AUDITORIA_2026-10-02.md), a escala da persistência virou uma onda própria (W1) e P2.C1/P5.7 foram parcialmente entregues (gestão administrativa de sessões e dead-letter do outbox).

## 1. Definição de pronto

O programa está **pronto para produção** quando, ao mesmo tempo:

1. todos os itens de [PRODUCTION_READINESS.md](../operations/PRODUCTION_READINESS.md) estão marcados, cada um com evidência datada (comando, packet ou ata de decisão);
2. o [RELEASE_CHECKLIST.md](../operations/RELEASE_CHECKLIST.md) passa inteiro no release de go-live;
3. o piloto da Fase 7 cumpre seus critérios de sucesso e a direção clínica assina o go/no-go.

Código pronto sem esses três não é produção. Uma decisão humana pendente também não pode ser "resolvida" por inferência no código.

## 2. Ponto de partida (02/10/2026)

| Área | Estado |
| --- | --- |
| Código e testes | `npm test` passou 768/768 testes em 91 arquivos; o recálculo unitário registrou 92,79% lines, 86,12% branches e 94,23% functions. A cobertura agregada passou 809/809 testes em 98 arquivos, com 94,98% lines, 89,09% branches e 95,30% functions; `coverage:gate` passou com 29 exceções temporárias sem uncovered/stale. O build passou e a matriz Playwright passou 63/63 sem retry. Typecheck, lint, OpenAPI, rastreabilidade e mutation 7/7 passam. |
| Deploy | Imagens `runner` e `ops`, `docker-compose.prod.yml` com TLS, bootstrap do primeiro ADMIN. Stack verificado em modo produção. |
| Segurança | CSP com nonce ativa, HSTS, CSRF, RBAC com escopo, rate limit por cliente em PostgreSQL, auditoria append-only, upload com antivírus fail-closed. |
| Aberto | 20 perguntas OQ abertas; 26/26 gates de prontidão abertos; sem troca de senha; sem alertas com dono; sem RPO/RTO; estado clínico em snapshot JSONB transitório; nenhum teste com usuário real. |

**Atualização executável de 02/10/2026:** a implementação acrescentou a migration `011_outbox_dead_letter`, controles administrativos de sessões/dead-letter e testes de UI. `npm run validate:migrations`, `npm run validate:docs`, `npm run validate:openapi` (70 operações/65 paths), `npm run validate:traceability`, `npm run security:scan`, typecheck, lint, build, E2E `63/63` sem retry, mutation `7/7` e `npm test` passaram. `npm run test:postgres` passou 41/41 e a cobertura agregada passou 809/809 testes em 98 arquivos com `coverage:gate` verde. Os gates técnicos locais estão verdes; isso não substitui aceite de produção, carga/failover, storage/AV real ou decisões humanas.

## 3. Visão geral

```
Fase 0  Decisões ───────────────┬──────────────────────────────────────────┐
                                ▼                                          ▼
Fase 1  Infraestrutura ──► Fase 2  Identidade ──► Fase 3  Regras clínicas  │
          │                                            │                   │
          └──────────► Fase 4  Dados e escala ◄────────┘                   │
                              │                                            │
                       Fase 5  Operação ──► Fase 6  Validação externa ──► Fase 7  Piloto ──► Fase 8  Go-live
```

- As fases 1 e 4 podem começar em paralelo à Fase 0, porque dependem só das decisões D2 e D11.
- O caminho crítico costuma ser **Fase 0 → Fase 3 → Fase 7**: as decisões clínicas é que travam.

Tamanhos usados abaixo, os mesmos do backlog: **S** ≤ 3 dias-pessoa; **M** 4–8; **L** 9–20; **XL** > 20 ou com dependência externa.

---

## Fase 0 — Decisões (responsáveis humanos)

Nada aqui é engenharia: cada linha precisa de uma ata com responsável, data e decisão, registrada em [DECISION_LOG.md](../DECISION_LOG.md) e propagada para Discovery → PRD → SPEC → testes.

| ID | Decisão | Perguntas | Responsável | Destrava |
| --- | --- | --- | --- | --- |
| D1 | Método de identidade: OIDC/AD institucional ou contas locais | OQ-012 | TI + segurança | Fase 2 |
| D2 | Volume, pico, disponibilidade, **RPO e RTO** do piloto e da produção | OQ-014 | TI + gestão | Fases 1, 4 e 5 (AUD-033) |
| D3 | Política de **resultado crítico**, escalonamento, fallback de plantão e necessidade de canal redundante | OQ-005, OQ-004, OQ-018 | Direção clínica + laboratório | Fase 3 (crítico) |
| D4 | Quem libera, emenda, anula, revisa e cancela, por serviço; significado de "revisado/confirmado/concluído" | OQ-002, OQ-003, OQ-015, OQ-017, OQ-001 | Direção clínica + responsáveis técnicos | Fase 3 (permissões) |
| D5 | LGPD: inventário, finalidade, **retenção**, exportação/exclusão, contatos de incidente; regra para homônimos | OQ-013, OQ-019 | Jurídico/privacidade | Fase 4 (retenção) |
| D6 | Sistema mestre de Paciente/Atendimento: integração ou cadastro manual no piloto | OQ-011 | TI | Fase 3 (integração) |
| D7 | Início, pausa e calendário de SLA por setor | OQ-006 | Gestores dos setores | Fase 3 (SLA) |
| D8 | Modelo de amostra/accession/etiqueta | OQ-008 | Laboratório | Fase 3 |
| D9 | Comportamento em alta, transferência e atendimento encerrado | OQ-007 | Gestão clínica + TI | Fase 3 |
| D10 | Catálogo inicial: exames, templates, unidades e faixas de referência; anexos de RX/US; agenda de US | OQ-016, OQ-010, OQ-009 | Responsáveis técnicos | Fase 3 (catálogo) |
| D11 | Infraestrutura: provedor (nuvem ou on-premise), PostgreSQL gerenciado, S3, antivírus, secret manager, domínio | — (AUD-034) | TI/SRE + patrocinador | Fase 1 |
| D12 | Escopo do piloto (setores, usuários, duração), métricas de sucesso e baseline | OQ-020 | Patrocinador + gestão | Fase 7 |
| D13 | Política de artefatos de processo e de commits | AUD-006, AUD-036 | Produto | Higiene (não bloqueia) |

**Critério de saída:** D1–D12 com ata. Se D3 ainda não estiver decidida, o piloto pode seguir com `CRITICAL_POLICY_ENABLED=false` e um fluxo de crítico fora do sistema documentado. Essa exceção precisa ser aceita por escrito pela direção clínica.

---

## Fase 1 — Infraestrutura de produção (engenharia + SRE)

| ID | Entrega | Aceite | Tamanho |
| --- | --- | --- | --- |
| P1.1 | CI verde no GitHub para a branch de release e proteção da `main` (PR obrigatório + checks) | Execução remota de todos os jobs verde, com link | S |
| P1.2 | Ambientes separados **staging** e **produção**, com bancos, buckets e segredos distintos | Nenhuma credencial compartilhada entre ambientes | M |
| P1.3 | Secret manager (D11) alimentando o `.env.production`; rotação documentada de `SESSION_SECRET`, `TRUST_PROXY_SHARED_SECRET` e credenciais | Nenhum segredo em arquivo versionado ou em histórico de shell | M |
| P1.4 | Registry de imagens + pipeline de deploy: build → scan Trivy → push com tag do commit → deploy automático em staging → deploy manual com aprovação em produção | Deploy de staging a partir de um merge, sem acesso SSH manual | M |
| P1.5 | PostgreSQL gerenciado ou dedicado, com **PITR/WAL archiving** dimensionado por D2 | Restore point-in-time demonstrado em staging | M |
| P1.6 | Contas de banco com menor privilégio: usuário de migration (DDL) separado do usuário de runtime (DML), que não altera schema nem apaga `audit_events` | Teste: o usuário de runtime falha ao rodar `DROP`/`ALTER` | S |
| P1.7 | S3 de produção com criptografia, versionamento, bloqueio de acesso público e política de ciclo de vida alinhada a D5 | Upload, download e quarentena reais verificados em staging | S |
| P1.8 | Antivírus externo real (HTTPS, allowlist de host) e responsável pela quarentena | Arquivo EICAR enviado em staging é quarentenado | M |
| P1.9 | DNS, TLS, firewall (somente 80/443 públicos) e acesso administrativo por VPN/bastion | Varredura externa de portas mostra só 80/443 | S |

**Critério de saída:** staging sobe pelo pipeline com serviços reais, e `/readyz` responde `postgres` + `s3`.

---

## Fase 2 — Identidade e contas (engenharia + segurança)

Depende de D1. Implementar **um** dos caminhos:

**Caminho A — OIDC/AD institucional (recomendado quando existir):**

| ID | Entrega | Tamanho |
| --- | --- | --- |
| P2.A1 | Login OIDC (authorization code + PKCE), mapeamento de grupos para roles e departamentos, desativação automática quando o usuário sai do diretório | L |
| P2.A2 | Conta local apenas para *break-glass*, com auditoria reforçada e alerta a cada uso | S |

**Caminho B — contas locais:**

| ID | Entrega | Tamanho |
| --- | --- | --- |
| P2.B1 | Troca de senha self-service (exige a senha atual e revoga as outras sessões) — AUD-046 | M |
| P2.B2 | Redefinição pelo ADMIN com token de uso único e expiração curta, com troca obrigatória no primeiro login | M |
| P2.B3 | Lockout/backoff progressivo por conta, além do rate limit por IP, com desbloqueio auditado | S |
| P2.B4 | Política de senha revisada (tamanho, lista de senhas vazadas) | S |

**Comum aos dois caminhos:**

| ID | Entrega | Tamanho |
| --- | --- | --- |
| P2.C1 | Tela "minhas sessões" com revogação; revogação de todas as sessões de um usuário pelo ADMIN | S |
| P2.C2 | Revisão de permissões com D4 aplicada à matriz RBAC (`docs/spec/PERMISSIONS.md` + testes de matriz) | M |

**Critério de saída:** testes de segurança de autenticação passam, e nenhum usuário depende do ADMIN para trocar a própria senha.

---

## Fase 3 — Regras clínicas implementadas (engenharia + clínica)

Cada item traduz uma decisão da Fase 0 em SPEC, teste e código, nessa ordem.

| ID | Entrega | Decisão | Tamanho |
| --- | --- | --- | --- |
| P3.1 | Política de resultado crítico ativada com versão, referência de aprovação e data (`CRITICAL_POLICY_*`); escalonamento e fallback de plantão | D3 | M |
| P3.2 | Canal redundante para crítico (e-mail/SMS/pager) como novo sink durável do outbox, com confirmação de entrega | D3, se exigido | L |
| P3.3 | Ownership de liberação, emenda, anulação, revisão e cancelamento por serviço | D4 | M |
| P3.4 | Calendário e pausas de SLA por setor; indicadores recalculados | D7 | M |
| P3.5 | Modelo de amostra/accession/etiqueta | D8 | M–L |
| P3.6 | Alta, transferência e encerramento: notificações e pendências redirecionadas | D9 | M |
| P3.7 | Catálogo de produção carregado via API/admin (sem seed): exames, templates, unidades e faixas aprovadas | D10 | M |
| P3.8 | Integração com o sistema mestre de Paciente/Atendimento (importação ou API, deduplicação, IDs externos) **ou** procedimento de cadastro manual aprovado | D6 | L–XL |
| P3.9 | Agenda de ultrassom: integração mínima ou procedimento manual | D10 | M |

**Critério de saída:** as jornadas de laboratório normal, recoleta, RX, US, crítico, atraso e cancelamento rodam em staging com as regras aprovadas, e a matriz de rastreabilidade é atualizada.

---

## Fase 4 — Dados, privacidade e escala (engenharia)

| ID | Entrega | Aceite | Tamanho |
| --- | --- | --- | --- |
| P4.1 | **Teste de carga representativo** com o volume e o pico de D2, em staging com dados sintéticos no tamanho esperado de 12 meses | p95 dentro da meta da NFR; zero erros; relatório anexado | M |
| P4.2 | **Persistência relacional (obrigatória).** Hoje todo o estado vive numa única linha JSONB, lida em fila serial por processo e regravada inteira a cada escrita. A auditoria de 02/10/2026 mediu ~0,6 s de CPU por requisição com 100 mil eventos de auditoria (F-01). Primeiro as mitigações (PROD-101…106), depois o cutover para as tabelas das migrations 007–010 (PROD-111) | Benchmark de 12 meses dentro da meta; dual-read sem divergência; rollback ensaiado | XL |
| P4.3 | Retenção e expurgo conforme D5 (job agendado, auditado, cobrindo anexos no S3) | Teste de expurgo em staging | M |
| P4.4 | Exportação e exclusão de dados do titular (LGPD), dentro dos limites legais de retenção clínica | Fluxo documentado e testado | M |
| P4.5 | Migrations testadas a partir de um dump representativo da versão anterior; plano de roll-forward/rollback por migration | Ensaio em staging registrado | S |
| P4.6 | Varredura de logs, bundle e fixtures sem dado pessoal real nem segredo | Secret scan + amostragem de logs de staging | S |

---

## Fase 5 — Operação (SRE)

| ID | Entrega | Aceite | Tamanho |
| --- | --- | --- | --- |
| P5.1 | Coleta de métricas (`/api/v1/metrics` autenticado) em Prometheus ou equivalente, com dashboards de app, banco, outbox e realtime | Dashboard em staging | M |
| P5.2 | Agregação de logs JSON com busca por `correlationId` e retenção definida | Um 500 forçado em staging é encontrado pelo correlation ID | S |
| P5.3 | **Alertas com dono e roteamento** (AUD-020): readyz, taxa de 5xx, latência, fila e dead-letter do outbox, falhas de login, disco e conexões do banco, falha de backup, certificado vencendo | Cada alerta disparado ao menos uma vez em staging e recebido pelo responsável | M |
| P5.4 | Backup de PostgreSQL **e** S3 com o restore completo da aplicação exercitado contra o RPO/RTO de D2 (AUD-033) | Ata do exercício com tempos medidos | M |
| P5.5 | Runbooks ensaiados: incidente, banco fora, storage fora, antivírus fora, crítico não entregue, rede degradada | Um ensaio por runbook registrado | M |
| P5.6 | Escala de plantão/suporte, contatos de incidente e janela de manutenção | Documento publicado | S |
| P5.7 | Tratamento do dead-letter do outbox (consulta, reprocessamento e descarte auditados) | Teste em staging | S |

---

## Fase 6 — Validação independente

| ID | Entrega | Aceite | Tamanho |
| --- | --- | --- | --- |
| P6.1 | Pentest externo: autenticação, IDOR, escalonamento de privilégio, upload, injeção, headers | Zero achado crítico ou alto aberto | L (externo) |
| P6.2 | Inspeção manual de acessibilidade: leitor de tela, zoom 200% e touch nos fluxos principais (AUD-029) | Registro por fluxo; bloqueadores corrigidos | M |
| P6.3 | Revisão do threat model com o código final | Assinatura de segurança | S |
| P6.4 | Re-execução integral dos gates com packet novo e hash (AUD-037) | Todos verdes no commit candidato | S |
| P6.5 | Revisão independente com nota ≥ 85 e zero achado crítico ou alto (AUD-038) | Parecer registrado | M (externo) |

---

## Fase 7 — Piloto controlado

| ID | Entrega | Aceite |
| --- | --- | --- |
| P7.1 | Homologação (UAT) em staging com usuários reais de cada setor, cobrindo cada jornada do PRD | Termo de aceite por jornada |
| P7.2 | Treinamento: próximas ações, ack de crítico, modo degradado/offline, como pedir suporte | Lista de presença + material |
| P7.3 | Piloto em produção com o escopo de D12 (ex.: um setor e um turno), com procedimento manual de contingência ativo | Contingência testada no 1º dia |
| P7.4 | Medição das métricas de sucesso contra o baseline; janela de feedback; correções priorizadas | Relatório do piloto |
| P7.5 | Go/no-go assinado pela direção clínica, TI e patrocinador | Ata |

---

## Fase 8 — Go-live e estabilização

| ID | Entrega |
| --- | --- |
| P8.1 | Release seguindo o [RELEASE_CHECKLIST.md](../operations/RELEASE_CHECKLIST.md) inteiro, com notas de release |
| P8.2 | Expansão por setor, cada uma com seu próprio go/no-go curto |
| P8.3 | Hypercare de 2–4 semanas: plantão reforçado, revisão diária de alertas e do outbox |
| P8.4 | Retrospectiva e atualização de PRODUCTION_READINESS para `READY`, com a evidência ligada a cada item |

---

## 4. Cobertura dos gates

| Gate de [PRODUCTION_READINESS.md](../operations/PRODUCTION_READINESS.md) | Fechado por |
| --- | --- |
| Produto/clínico (4 itens) | Fase 0 (D3, D4, D8, D9) + P3.* + P7.1 |
| Autenticação, sessão, RBAC, CSRF, headers, TLS | Fase 2 + P1.9 + P6.1 |
| IDOR, escalonamento, SQLi/XSS, upload | P6.1 |
| Rate limit distribuído | já implementado; confirmar em P6.4 |
| Antivírus externo e quarentena | P1.8 |
| Threat model e imutabilidade da auditoria | P6.3 + P1.6 |
| LGPD | D5 + P4.3 + P4.4 |
| Sem segredos ou dado real | P1.3 + P4.6 |
| Migrations e rollback | P4.5 |
| Snapshot JSONB | P4.2 |
| Backup/restore e RPO/RTO | D2 + P1.5 + P5.4 |
| Health, logs, métricas, outbox, alertas | P5.1–P5.3 + P5.7 |
| Storage, scan e download assinado | P1.7 + P1.8 |
| Runbooks ensaiados | P5.5 |
| Suíte completa e cobertura de negócio | P6.4 |
| Responsividade e estados de UX | P6.2 + P7.1 |
| Performance representativa | P4.1 |
| Sem implementação falsa ou alerta sem dono | P5.3 + P6.5 |
| Ambientes e secret manager | P1.2 + P1.3 |
| Proxy, acessos e contas de serviço | P1.6 + P1.9 |
| Smoke, release notes, rollback, dono de suporte | P5.6 + P8.1 |
| Escopo e feedback do piloto | D12 + P7.* |

## 5. Ordem prática recomendada

1. **Agora:** agendar as reuniões da Fase 0 (D1, D2, D11 primeiro); fechar P1.1; começar P1.2–P1.4.
2. **Com D1 decidida:** Fase 2. **Com D2:** P1.5 e P4.1. **Com D11:** P1.7–P1.9.
3. **À medida que D3–D10 forem decididas:** cada item da Fase 3, em staging.
4. **Desde já, em paralelo:** P4.1 e P4.2 (onda W1 do roadmap); a Fase 5 começa com a Fase 3 estável.
5. **Código congelado para o piloto:** Fase 6 e, em seguida, a Fase 7.
6. **Go/no-go positivo:** Fase 8.

O que pode ser feito sem esperar nenhuma decisão: P1.1, P1.4, P1.6, P2.C1, P4.5, P4.6, P5.1, P5.2 e P5.7.
