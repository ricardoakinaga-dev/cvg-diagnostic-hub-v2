# Backlog State of Art / AAA

> **Histórico AAA-1:** substituído para planejamento corrente pelo [programa AAA-2](AAA_2_BACKLOG.md), em 05/09/2026, com base na [nova auditoria](../RELATORIO_AUDITORIA_2026-09-05.md). Conteúdo e estados abaixo preservados como registro anterior; não representam evidência atual.

**Barra:** [`STATE_OF_ART_QUALITY_BAR.md`](STATE_OF_ART_QUALITY_BAR.md)  
**Roadmap:** [`STATE_OF_ART_ROADMAP.md`](STATE_OF_ART_ROADMAP.md)  
**Legenda:** `P0` bloqueia segurança/integridade/avanço; `P1` bloqueia completude AAA; `P2` depende de decisão ou preparação externa. `DONE` só será usado com evidência atual e integrada.

## W0 — bloquear menos e medir melhor

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W0-001 | P0 | Corrigir aliases do Vitest PostgreSQL e adicionar teste de paridade de configuração | Testes | nenhuma | `npm run test:postgres` coleta toda a suíte e falha apenas por ambiente ausente quando não há banco | REVIEW |
| AAA-W0-002 | P0 | Executar integração PostgreSQL em CI-equivalente com migrations, concorrência, reload, rollback e duas instâncias | Dados | W0-001 | suíte real verde com banco descartável e evidência sanitizada | BLOCKED ENVIRONMENT |
| AAA-W0-003 | P0 | Remediar `fast-uri` transitivo e fixar lockfile seguro | Supply chain | nenhuma | `npm audit --audit-level=high` sai 0 e contratos continuam verdes | REVIEW |
| AAA-W0-004 | P0 | Isolar rate limit, cookies, seed e servidor entre contextos E2E | Browser | nenhuma | primeira execução E2E 100% verde em três projetos, sem retry necessário | REVIEW |
| AAA-W0-005 | P1 | Tornar perf smoke, accessibility e E2E artefatos versionáveis com ambiente e hash | Qualidade | W0-004 | cada gate produz digest sanitizado ligado ao commit | REVIEW |
| AAA-W0-006 | P1 | Atualizar números, datas e status em traceability, test plan, readiness, release checklist e UX flows | Docs | relatório AAA | nenhum documento chama evidência antiga de current | REVIEW |
| AAA-W0-007 | P1 | Reconciliar `.agent/state.json`, commit atual, remote V1 e referências do mapa de migração | Docs/Lead | W0-006 | estado aponta o artifact real; preservação V1 é fato verificável ou explicitamente histórica | REVIEW |
| AAA-W0-008 | P1 | Integrar a barra AAA ao índice, source of truth e registro de verificação | Docs/Lead | W0-006 | qualquer executor encontra barra, plano, roadmap e backlog atuais | REVIEW |

## W1 — dados duráveis e recuperáveis

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W1-001 | P0 | Modelar schema relacional para user/session, patient/owner, encounter/admission, request/item, service, sample/procedure, result/version, attachment, notification, audit/outbox | Dados | W0-002 | schema review com FKs, checks, unique keys e índices justificados | REVIEW |
| AAA-W1-002 | P0 | Implementar migrations incrementais com checksum, compatibilidade de versões e rollback/roll-forward seguro | Dados | W1-001 | banco parte do baseline e chega ao schema alvo sem perda silenciosa | REVIEW |
| AAA-W1-003 | P0 | Retirar o snapshot JSONB clínico como fonte autoritativa, com dual-read/backfill/cutover observável | Dados | W1-002 | `runtime_storage_boundaries` deixa de ser transição não resolvida | PENDING |
| AAA-W1-004 | P0 | Provar invariantes de item/result, idempotência, versionamento, auditoria e outbox sob concorrência real | Dados | W1-002 | testes multi-transação verdes e inspeção de linhas/constraints | PENDING |
| AAA-W1-005 | P1 | Rodar `EXPLAIN` com volumes, skew, vazio, paginação e timezone representativos | Performance | W1-001 | planos dentro do orçamento e índices justificados por evidência | PENDING |
| AAA-W1-006 | P0 | Fazer restore de PostgreSQL, object storage, metadata de chaves e anexos | Operações | W1-002 | restore isolado atende RPO/RTO aprovados e checksum confere | BLOCKED EXTERNAL |
| AAA-W1-007 | P0 | Executar migration 007 em PostgreSQL descartável e produzir EXPLAIN/rollback/backfill evidence | Dados/Performance | W1-001/002 | migration, constraints, índices, rollback/roll-forward e planos são exercitados com dados representativos | BLOCKED ENVIRONMENT |

## W2 — segurança institucional e supply chain

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W2-001 | P0 | Integrar identidade institucional sem enfraquecer sessão local, CSRF, RBAC e escopo | Segurança | decisões hospitalares | IdP/subject/role/scope auditados e casos negativos verdes | BLOCKED EXTERNAL |
| AAA-W2-002 | P0 | Formalizar ownership, delegated manager, departamento, transferência e alta | Produto/Clínica | decisão hospitalar | matriz assinada, enforcement no servidor e journeys de transição | BLOCKED EXTERNAL |
| AAA-W2-003 | P0 | Trocar scanner local por serviço AV externo, com timeout, quarantine, incident ownership e fallback seguro | Segurança/Operações | endpoint aprovado | upload só libera após confirmação limpa; falha permanece visível | BLOCKED EXTERNAL |
| AAA-W2-004 | P0 | Ativar rate limiting distribuído PostgreSQL ou equivalente aprovado, com outage fail-closed | Segurança | W1-002 | duas instâncias compartilham bucket e não há bypass por proxy header | PENDING |
| AAA-W2-005 | P1 | Revisar cookies, TLS, ingress, secrets, rotação, CORS, headers e logs em configuração produtiva | Segurança/Infra | W2-001 | checklist de configuração e smoke produtivo sem segredo exposto | BLOCKED EXTERNAL |
| AAA-W2-006 | P1 | Reexecutar threat model com testes de abuso, IDOR, privilege escalation, upload e replay | Segurança | W2-001–005 | nenhum CRITICAL/HIGH local sem owner e reteste | PENDING |

## W3 — Patient Workspace e contexto clínico

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W3-001 | P0 | Entregar Patient Workspace com patient/encounter/admission, owner, request, timeline e next action | Produto | W1, W2 | deep link, reload, escopo e ações server-owned passam em API/UI | PENDING |
| AAA-W3-002 | P0 | Resolver identidade, homônimo e referência externa sem seleção ambígua | Produto/Clínica | W2-002 | confirmação contextual e auditoria de identidade | BLOCKED EXTERNAL |
| AAA-W3-003 | P0 | Implementar sample/accession lineage e recolleta/replacement relacional | Lab/Dados | W1, W3-001 | nenhum item órfão; cadeia e ownership sobrevivem a retry/concurrency | PENDING |
| AAA-W3-004 | P1 | Completar request lifecycle: múltiplos itens, duplicate, priority, cancel, transfer e alta | Workflow | W3-001/002 | transições normais e proibidas provadas por serviço, API e browser | PENDING |

## W4 — verticais e comunicação clínica

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W4-001 | P0 | Criar authoring/review/publish de templates Lab versionados e aprovados | Lab/Clínica | W2-002, W3 | catálogo tem owner, revisão, faixa, unidade e população aprovados | BLOCKED EXTERNAL |
| AAA-W4-002 | P0 | Completar Lab receive/process/reject/recollect/replace/release por sample | Lab | W3-003, W4-001 | jornada servida sem mock, lifecycle e audit trail completos | PENDING |
| AAA-W4-003 | P1 | Completar RX e US com procedure, schedule, reschedule, attachment e report lifecycle | Imaging | W3-001 | caminhos não compartilham estados incorretos de Lab | PENDING |
| AAA-W4-004 | P0 | Aprovar e implementar result release/review/amend/void e version lineage | Clínica | W2-002, W3 | ownership, expected version, re-review e confidencialidade provados | BLOCKED EXTERNAL |
| AAA-W4-005 | P0 | Aprovar critical thresholds, recipients, fallback, escalation e acknowledgment | Clínica | owner clínico | política assinada, testes e runbook exercitado | BLOCKED EXTERNAL |
| AAA-W4-006 | P1 | Implementar notificações transacionais, inbox, outbox, dedupe, retry, escalation e dead letter | Plataforma | W2-004, W4-005 | sink confirmation e critical ack distintos em duas instâncias | PENDING |

## W5/W6 — operação, performance e UX AAA

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W5-001 | P0 | Evoluir outbox/SSE para fanout multi-instância com replay/resync e bounded resources | Plataforma | W1, W2-004, W4-006 | reconnect, expiry, worker crash e autorização passam | PENDING |
| AAA-W5-002 | P1 | Instrumentar logs, traces, metrics, SLO, alertas e correlation end-to-end | Operações | W5-001 | falhas injetadas geram diagnóstico acionável | PENDING |
| AAA-W5-003 | P0 | Executar benchmark representativo de endpoints, buscas, filas e dashboard | Performance | W1-005, W3 | p50/p95/p99, throughput, erro e recursos dentro do target AAA | BLOCKED ENVIRONMENT |
| AAA-W5-004 | P1 | Executar chaos/restart/dependency outage/queue poison drill | SRE | W5-002 | recovery, backoff, dedupe e alertas comprovados | PENDING |
| AAA-W6-001 | P1 | Fazer inspeção manual responsive, keyboard, touch, contrast, reader e reduced motion | UX/A11y | W3–W5 | aceite manual sem achado bloqueante e evidência versionada | BLOCKED EXTERNAL |
| AAA-W6-002 | P1 | Completar loading/empty/error/partial/offline/degraded/denied em jornadas críticas | UX | W3–W5 | cada estado é navegável e acionável nos três viewports | PENDING |
| AAA-W6-003 | P1 | Revisar hierarquia, densidade, tipografia, tokens e consistência visual por screenshot | UX | W6-001 | review contra âncoras AAA sem regressão funcional | PENDING |

## W7/W8 — release e governança

| ID | Pri | Item | Dono | Dependência | Aceite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AAA-W7-001 | P0 | Fazer CI remoto verde com todos os gates e Node baseline fixado | DevEx | W0–W6 | workflow passa sem retry ocultando falha | BLOCKED ENVIRONMENT |
| AAA-W7-002 | P0 | Atualizar traceability para ligar cada FR/NFR/AC a código, teste, comando e digest | Qualidade | W0–W6 | nenhuma linha MUST sem evidência atual | PENDING |
| AAA-W7-003 | P0 | Criar release/rollback packet, runbooks, incident owner e support ownership | Operações | W5–W7 | checklist assinado e rollback ensaiado | PENDING |
| AAA-W7-004 | P0 | Rodar crítica independente final contra `AAA-1` e corrigir todo gap material | Lead/Critic | W7-001–003 | Final Critic `APPROVE`, mutation sentinel limpo | REWORK |
| AAA-W7-005 | P1 | Endurecer CI com `fail-on-flaky-tests` e retenção de artefatos diagnósticos em falha | DevEx | W0-004 | workflow validado e uma execução remota captura cobertura, traces e logs em qualquer falha | REVIEW |
| AAA-W8-001 | P0 | Aprovar retenção, residência, LGPD, export/delete, RPO/RTO e incident contacts | Privacidade/Infra | release packet | políticas assinadas e evidência operacional | BLOCKED EXTERNAL |
| AAA-W8-002 | P0 | Executar aceite clínico, piloto controlado, treinamento e rollback authority | Hospital/Clínica | W8-001 + release packet | aceite I3 e decisão formal de release | BLOCKED EXTERNAL |

## Política de manutenção

Um item pode avançar de `PENDING` para `READY` somente quando suas dependências e contrato estiverem comprovados. `IMPLEMENTED` significa que o builder alterou o artifact e entregou evidência; `VERIFIED` exige verificação independente; `DONE` exige integração. Falha repetida com a mesma hipótese retorna o item para replanejamento, não para retry infinito.
