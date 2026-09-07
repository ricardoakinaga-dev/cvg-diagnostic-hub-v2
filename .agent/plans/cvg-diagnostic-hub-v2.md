# CVG Diagnostic Hub V2 — ExecPlan

## Goal

Evoluir o checkout brownfield do CVG Diagnostics Hub para a primeira fatia
executável do programa V2, mantendo V1 disponível e estabelecendo uma base de
monorepo modular para as jornadas veterinárias completas. A primeira entrega
vertical torna a operação explícita: Command Center attention-first e Central de
Exames com projeção estruturada de owner, próxima ação, bloqueio, espera, prazo e
escalonamento, todos derivados no servidor e cobertos por testes.

Este plano não autoriza release hospitalar nem inventa política clínica. O
programa maior permanece aberto até que os domínios clínicos e gates externos
tenham evidência própria.

## Status e fonte de verdade

- **Stage:** BUILD/VERIFY/AUDIT concluído condicionalmente para a fatia Laboratório
  estruturado e para o backfill shadow relacional local, após correção do
  release legado, do catálogo e da paridade de contrato; próxima fronteira:
  evidência de ambiente-alvo para o seam relacional.
- **Tier/risk/blast radius:** `T3_SYSTEM` / `HIGH` / `SYSTEM`.
- **Quality bar:** `docs/v2/QUALITY_BAR.md`.
- **Migration map:** `docs/v2/MIGRATION_MAP.md`.
- **Laboratory slice:** `docs/v2/LABORATORY_VERTICAL.md`.
- **Control plane histórico:** `.agent/` e `.gauntlet/`; registros V4 anteriores
  continuam históricos e não são sobrescritos.
- **Official remote:** `origin` aponta para
  `https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2`.
- **V1 preservation:** `v1` aponta para
  `https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub` e o histórico local
  continua disponível.

## Discovery evidence

- O checkout atual é uma aplicação Next.js 16 de raiz, com `src/app`,
  `src/components`, `src/server` e `packages/contracts`; ainda não é o monorepo
  `apps/web` + `apps/api` do alvo.
- A aplicação já tem state machine, RBAC server-side, auditoria, persistência,
  realtime, fixtures sintéticas e comandos clínicos que devem ser preservados.
- `read-service.listQueue` devolve uma string de `nextAction`, mas não o contexto
  operacional estruturado pedido pelo V2; `dashboard` devolve métricas, sem uma
  lista attention-first e sem resumo de setores.
- A fila atual é uma tabela sem detalhe contextual; o detalhe completo existe,
  mas tira o operador da fila.
- Typecheck e lint passaram na baseline; a execução inicial da suite falhou no
  Node 18 por incompatibilidade ESM entre Vitest/Vite. Node 22 está disponível
  via `npx node@22` e deve ser usado para as verificações compatíveis.
- O Plane foi observado em commit `1d0ee2482a5da02f18907d04f06eb9966feaa238`.
  Foram reutilizados princípios de shell, views tipadas, drawer, command
  registry, services e design tokens; não foi copiado código ou branding.

## Scope

### In scope — onda 1

1. Extrair uma regra de domínio pura para contexto operacional, mantendo
   compatibilidade com a label `nextAction` existente.
2. Expandir contrato/read model/API da fila e dashboard com os campos estruturados
   e atenção/setores, preservando autorização e envelope existentes.
3. Introduzir uma primeira fronteira real de package (`domain` e primitives/UI
   consumidos pelo runtime) e uma feature-oriented composition para Command Center
   e Central de Exames.
4. Entregar loading, erro, vazio, permissão negada e estado degraded/stale onde a
   leitura possa falhar ou estar incompleta.
5. Entregar drawer contextual acessível, filtros e links para o workspace completo.
6. Adicionar testes RED/GREEN de domínio, contrato/API, autorização, componentes,
   acessibilidade aplicável e uma jornada E2E.
7. Atualizar OpenAPI/docs/traceability e os registros de evidência sem reescrever
   a história V4.

### Out of scope — explicit human/next waves

Implementação completa de Lab/RX/US, thresholds de crítico, identidade hospitalar,
dados reais, produção, migração relacional final, observabilidade externa, CI
remoto, aceite clínico, piloto e push/release no GitHub oficial.

### In scope — fatia 2: Laboratório estruturado

1. Versionar um template sintético de Hemograma no catálogo e expor leitura
   autenticada/escopada.
2. Validar observações tipadas no domínio e normalizar snapshot de faixa/flag,
   sem inventar thresholds ou criticidade.
3. Reusar draft/release/amend/void/review, idempotência, concorrência, auditoria
   e outbox do runtime atual.
4. Alinhar comandos Zod, OpenAPI, respostas reais e ResultView com tabela/editor
   de analitos.
5. Provar o caminho com testes de domínio/aplicação/API/UI e jornada Chromium.

O conteúdo legado permanece aceito somente como draft de migração/edição. O
release de um serviço numérico com template ativo revalida o conteúdo e bloqueia
qualquer draft legado ou incompleto; a política de cutover para eliminar essa
compatibilidade de leitura continua sendo uma decisão posterior.

## Architecture

```text
packages/domain          pure operational rules and invariants
packages/contracts       API/domain boundary types and schemas
packages/ui              accessible primitives/tokens used by the slice
packages/services        typed client boundary as the web migration advances
packages/shared-state    drawer/filter preferences only
apps/api/src/modules     eventual modular-monolith bounded contexts
apps/web/features        feature composition and route adapters
```

During the transition the existing root Next app remains the executable host.
New package/feature imports must be real and tested; creating empty directories or
copying the whole application into `apps/*` is not evidence of migration. The
root host will move only after the first boundary has no hidden root alias or
runtime dependency that would make the move misleading.

## Quality bar

The binary criteria are frozen in `docs/v2/QUALITY_BAR.md`. No implementation
milestone can be marked complete without a fresh command/test/evidence reference.

## Work graph

```text
TASK-V2-PLAN-001
  ├─ TASK-V2-DOMAIN-001
  │    └─ TASK-V2-CONTRACT-001
  │         ├─ TASK-V2-API-001
  │         └─ TASK-V2-UI-001
  │              └─ TASK-V2-JOURNEY-001
  ├─ TASK-V2-FOUNDATION-001
  └─ TASK-V2-AUDIT-001
       └─ TASK-V2-RETEST-001

TASK-V2-LAB-DOMAIN-001
  └─ TASK-V2-LAB-CONTRACT-001
       ├─ TASK-V2-LAB-API-001
       └─ TASK-V2-LAB-UI-001
            └─ TASK-V2-LAB-JOURNEY-001
                 └─ TASK-V2-LAB-AUDIT-001
```

Shared route/type files are a serialized integration hotspot. Independent docs,
read-only critique and fixture review may run in parallel, but only the
coordinator integrates changes after inspecting every diff.

## Milestones and acceptance

### M0 — plan and foundation

- Quality bar, migration map and control-plane pointers exist.
- Origin/V1 remotes are explicit and no external push occurs without instruction.
- The first package boundary is consumed by the running application.

### M1 — operational domain and contract

- `currentOwner`, `nextAction`, `blockedBy`, `waitingSince`, `expectedBy` and
  `escalationLevel` are computed from typed state and returned by the server.
- Unknown or unsupported state fails safely and retains an auditable technical
  fallback; no invented clinical threshold is encoded.
- API/OpenAPI/runtime/type tests agree, including authorization and empty cases.

### M2 — Command Center and Central de Exames

- Attention items precede aggregate metrics and are server-sorted.
- Sector summary is real, scoped and explicitly handles degraded/partial reads.
- Queue filters do not mutate status; drawer preserves queue context, Escape,
  focus behavior and deep link; full workspace remains available for complex work.

### M3 — verification and criticism

- Node-compatible unit suite, typecheck, lint, build, contract checks, E2E and
  accessibility checks pass for the changed surface.
- Fresh read-only critic compares artifact to the prompt and V2 bar; each material
  finding is fixed or recorded as an explicit blocker.
- Evidence and limitations are written into the V2 gauntlet checkpoint.

### M4 — Laboratório estruturado

- A revisão de painel e seus analitos são uma fonte única para domínio, API e UI.
- Conteúdo estruturado incompleto, stale, duplicado ou com unidade/tipo inválido
  falha no servidor antes de alterar o estado.
- Conteúdo legado de um painel ativo pode permanecer em draft para migração, mas
  nunca atravessa o release; serviços numéricos novos exigem template ativo.
- Flags e faixas são versionadas no resultado; criticidade e fallback continuam
  bloqueados por política humana.
- O editor de Hemograma funciona no artifact servido e o contrato AJV valida
  respostas reais do endpoint de template e do resultado.

## Implementation notes and invariants

- `nextAction` is a compatibility label, not a permission. A button invokes a
  named server command that checks role, department, ownership, lifecycle and
  expected version.
- `escalationLevel` is operational urgency derived from existing priority/SLA
  information. Clinical critical-result policy remains external until approved.
- The browser may own drawer selection and filter preferences, never a clinical
  state projection that can diverge from the server.
- Cross-sector reads must return denial or a scoped absence; they must not infer
  from client-hidden rows.
- Synthetic fixtures remain clearly synthetic and cannot be used as hospital
  readiness evidence.
- Laboratory templates and ranges are technical fixtures until OQ-016/OQ-005 and
  the related human gates are approved; `UNINTERPRETED` is an intentional safe
  state, not a clinical conclusion.

## Verification matrix

| Surface | Command/evidence | Required result |
| --- | --- | --- |
| Domain | Node22 Vitest focused tests | state matrix and unknown-state negatives pass |
| API/application | Vitest route/read-service/authorization tests | runtime shape and scope match contract |
| UI | component/accessibility tests | drawer/filter/state behavior passes |
| Artifact | `npm run typecheck`, `npm run lint`, `npm run build` | pass |
| Regression | existing unit/coverage suite under compatible Node | no prior regression |
| Browser | focused E2E on Command Center and queue drawer | real served read/action journey passes |
| Audit | fresh read-only critic | no unresolved local CRITICAL/HIGH in slice |
| Laboratory | Node22 Vitest, OpenAPI/AJV, component and Chromium journey | typed panel round-trip passes and limitations remain explicit |

## Risks and human gates

- The official V2 remote is empty, so no claim of remote integration or release is
  made until the owner explicitly asks for a push.
- Existing Node 18 is below the repository's documented Node 20.9+ baseline; use
  the available Node 22 runner for verification and report the environment.
- Clinical owner, critical threshold, escalation recipient, retention and
  production infrastructure decisions remain human-owned blockers.
- Moving to `apps/web`/`apps/api` too early could create duplicate runtimes;
  packages and feature boundaries therefore precede physical app relocation.
- The current snapshot boundary and legacy `content` compatibility are retained
  only for migration safety; release is fail-closed for active numeric panels,
  and neither is evidence of a completed relational clinical model or a full
  mandatory structured cutover.

## Recovery

On interruption, read `AGENTS.md`, this plan, `docs/v2/QUALITY_BAR.md`,
`.agent/state.json`, `.agent/backlog.json`, the latest V2 gauntlet checkpoint and
the actual Git tree. Re-run the last recorded verification before resuming. Do
not treat old V4 `PASS_WITH_CONDITIONS` evidence as evidence for V2.

## Definition of done for this plan

All V2 wave-1 criteria pass with fresh evidence, the first package boundary is
runtime-consumed, the Command Center and contextual queue drawer work against the
real API, regression/quality checks are green, and remaining global/external work
is listed without being represented as complete. This is recorded as
`PASS_WITH_CONDITIONS` in `.gauntlet/state.md` and does not advance the global
program to release readiness.

## Wave 1 closure evidence

- Full local regression: 283 tests across 48 files, coverage 89.17% statements,
  83.93% branches and 96.4% functions; typecheck, lint and Next production build
  passed under Node 22 via `npx node@22`.
- Contract/docs/security: Redocly and generated OpenAPI drift passed at 63
  operations/58 paths; docs validation, secret scan and `git diff --check` passed.
- Served artifact: Chromium core flows plus accessibility passed 12/12, including
  the Command Center, queue drawer at 390px, keyboard cycle, Escape and focus
  restoration.
- Independent critic: fresh read-only review found no unresolved local
  CRITICAL/HIGH issue after the attention, degraded, scope, contract and focus
  fixes. The global V2 remains `NOT READY`.

## Laboratory slice checkpoint (conditional closure)

- Implementation is present in contracts/domain/catalog/API/OpenAPI/ResultView and
  is documented in `docs/v2/LABORATORY_VERTICAL.md`.
- The pre-remediation independent critic found a P0 release bypass. The server
  release gate, queue action, ResultView legacy state and numeric catalog guard
  were corrected; focused retest is green.
- Final evidence is 293 tests/49 files with 89.25% statements, 83.94% branches
  and 96.51% functions; OpenAPI is 64 operations/59 paths with Redocly/drift/AJV
  green; clinical Chromium is 3/3 and core/accessibility Chromium is 12/12.
- The final read-only critic confirmed the release/catalog/UI remediations but
  reported an alleged required `critical` field. Inspection of the generated
  schema and a new runtime/OpenAPI parity regression proved that claim false:
  `critical` remains optional in both contracts. Template authoring, sample /
  accession linkage and clinical policy remain explicit next-wave limits.
- At the time of this Laboratory checkpoint, thresholds/critical behavior,
  sample/accession linkage, relational persistence, Patient Workspace and
  clinical acceptance were not implemented or approved. Later V2 checkpoints
  below supersede the implementation status of the sample/accession and
  Patient Workspace items without changing the clinical-policy limit.

## Relational sample-lineage checkpoint (conditional closure)

- Migration 009 adds canonical accession, replacement-reason and link-status
  constraints while preserving the immutable 007/008 baseline. The adapter
  readiness query now requires those constraints to be both present and
  `convalidated`.
- Application, adapter, relational read boundary and cutover reconciliation
  preserve append-only replacement lineage, derived link metadata, optimistic
  versions and fail-closed scope. Reconciliation canonicalizes only known
  temporal fields to UTC, matching PostgreSQL `timestamptz` serialization while
  retaining invalid timestamps as mismatches.
- The historical local packet
  [`v2-relational-sample-lineage-postgres-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md)
  records PostgreSQL 16.15 in a disposable loopback cluster, 22/22 tests,
  live migration-009 constraint rejection, and projection/read/reconciliation
  across request, item, sample and link.
- The dedicated backfill packet
  [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md)
  records the populated request-scoped migration-010 shadow backfill with
  durable checkpoint, resume, idempotent replay, per-request reconciliation,
  exact-key completeness and fail-closed source drift; the final revalidation
  is 9/9 focused and 29/29 across the disposable PostgreSQL suite.
- The independent backfill critic report
  [`v2-relational-sample-lineage-backfill-critic-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md)
  records one initial HIGH and MEDIUM/LOW findings, their remediation and the
  final retest; no local CRITICAL/HIGH remains in the bounded slice.
- The slice remains conditional: JSONB is still runtime authority; full 007–010
  mapping, continuous dual-read/cutover, target-environment/browser
  persistence, representative EXPLAIN/load, independent final criticism and
  hospital policy/acceptance remain open.

## Hardening de replay — fronteira atual

O replay de um run `COMPLETED` deve continuar sendo uma verificação de
integridade, não apenas uma consulta do ledger. Antes de retornar sucesso, ele
precisa revalidar as chaves exatas das dez tabelas e reconciliar cada request
contra o snapshot atual, que continua sendo a autoridade. Corrupção, row extra,
row ausente ou metadata divergente no shadow deve produzir falha explícita, sem
alterar a autoridade nem promover o cutover. A regressão mínima é um teste
PostgreSQL que completa o run, corrompe o target, executa o mesmo `runId` e
observa `POSTGRES_RELATIONAL_BACKFILL_COMPLETENESS_MISMATCH` ou
`POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED`.

## Purpose / Big Picture

Este ExecPlan mantém uma única linha de execução para o programa V2: preservar
o host funcional, ampliar a fronteira clínica relacional com segurança e deixar
cada afirmação de qualidade ligada a uma evidência verificável. A conclusão
local não é convertida em autorização clínica, hospitalar ou de produção.

## Progress

- [x] (2026-09-06T03:34:00Z) Migração 009, vínculo completo de amostras,
  replay idempotente, rollback atômico e reconciliação hash foram implementados.
- [x] (2026-09-06T03:34:00Z) PostgreSQL 16.15 descartável passou 20/20 testes
  no packet local, com cleanup seguro e sem tocar o processo existente.
- [x] (2026-09-06T03:34:00Z) O control-plane legado foi preservado em snapshot
  imutável e reconstruído conforme o contrato v2.
- [x] (2026-09-06T08:02:12Z) Migration 010 e o backfill shadow request-scoped
  foram implementados; o teste PostgreSQL focado passou 9/9 com dado populado,
  checkpoint/retomada, replay idempotente, lock de origem, serialização entre
  pools, completude por chaves exatas e source drift fail-closed.
- [x] (2026-09-06T08:42:00Z) A crítica independente fresca foi registrada com
  todas as disposições e os gates finais foram reexecutados: validate 570/570,
  build 12 páginas, E2E 51/51 sem retries, acessibilidade 6/6, PostgreSQL
  completo 29/29, segurança, performance e recovery verdes.
- [x] (2026-09-06T09:36:40Z) Hardening do replay `COMPLETED` concluído
  localmente: RED real (8/9), GREEN focado 9/9, PostgreSQL completo 29/29,
  regressões de store 25/25, validate/build/browser/security/perf/recovery
  verdes. As duas críticas frescas expiraram sem relatório e permanecem
  `NOT_RUN`; por isso a fronteira externa continua aberta.
- [x] (2026-09-06T10:06:05Z) Revisão visual do Patient Workspace concluída em
  1440/834/375 CSS px: os cards mobile agora preservam serviço, status, próxima
  ação e responsável com wrapping; todas as próximas ações server-provided são
  visíveis; o recorte da timeline é explicitado; e os tokens secundários
  auditados passaram 4,5:1. Componentes 7/7, render 3/3, E2E 51/51,
  acessibilidade 6/6 e contraste passaram. O packet visual permanece
  `REVIEW REQUIRED`: crítica independente, screen reader manual, toque, zoom,
  reduced motion, métricas LCP/CLS e golden de produto não estão disponíveis.
- [x] (2026-09-06T10:53:50Z) Pós-crítica fresca do Patient Workspace: a crítica
  read-only de Erdos foi `CONDITIONAL`; paginação via `nextCursor`, skeleton
  estrutural, banner sem shift e rótulos operacionais foram corrigidos e
  cobertos. O packet atual foi regenerado com manifest/hash, screenshots e
  métricas; focused component 13/13, render 3/3, acessibilidade 6/6, validate
  570/570, build 12 páginas e E2E 51/51 permanecem verdes. O ledger continua
  `REVIEW REQUIRED` até sign-off visual pós-fix e os checks manuais/externos.

## Surprises & Discoveries

O checker canônico encontrou uma divergência de governança que os testes de
produto não capturam: o ledger usava IMPLEMENTED, VERIFY -> VERIFY,
PASS_WITH_CONDITIONS e ações textuais fora do contrato v2. A recuperação também
confirmou que a evidência PostgreSQL local é forte; a nova fatia populada fecha
somente o backfill shadow request-scoped, não o mapeamento completo, cutover,
carga representativa ou aceitação clínica.

A auditoria visual encontrou dois riscos de confiança na apresentação: dados
operacionais importantes eram truncados em 375px e contagens de listas
parcialmente renderizadas não declaravam seu recorte. A correção foi limitada à
camada de apresentação, preservando o snapshot e a autoridade server-owned.

## Decision Log

- 2026-09-06 — Preservar os ledgers legados byte a byte em
  .agent/legacy-control-plane-20260906 antes da migração.
- 2026-09-06 — Traduzir resultados condicionais para PASS somente quando a
  verificação local realmente foi concluída; manter condições e limites no gate
  VERIFIED e no estado PARTIAL.
- 2026-09-06 — Remover a dependência de verificação final do Patient Workspace
  da tarefa relacional; a implementação usa a fundação já existente, enquanto
  a crítica independente continua uma fronteira separada.
- 2026-09-06 — Não criar aprovação independente ou autorização de release para
  compensar workers indisponíveis.

## Outcomes & Retrospective

O resultado atual é um seam relacional tecnicamente exercitável, com invariantes
de associação, prontidão, replay, atomicidade e backfill populado/retomável
demonstradas em PostgreSQL descartável. A principal dívida remanescente é
ambiental e de governança, não um teste local vermelho: o runtime ainda usa
JSONB como autoridade, a migração completa não foi executada e o trabalho de
cutover exige evidência externa, revisão independente e decisões humanas.

## Context and Orientation

O host executável é a aplicação Next.js de raiz. Os packages compartilhados,
serviços de aplicação, adapter relacional, migrations e suites PostgreSQL formam
uma transição incremental; os documentos V2, o packet relacional e os ledgers
.agent são os pontos de navegação para a próxima sessão.

## Scope and Constraints

O escopo desta etapa é local, sintético, reversível e fail-closed. Inclui
contratos, migração, projeção, leitura, reconciliação, evidência e recuperação.
Exclui produção, dados clínicos reais, credenciais, deploy, cutover destrutivo,
thresholds clínicos, política hospitalar, carga representativa e publicação
externa. Um bloqueio não pode ser resolvido por uma afirmação textual.

## Architecture and Interfaces

A interface transicional mantém o JSONB como autoridade e publica a projeção
relacional como shadow seam. O adapter escreve linhas versionadas e append-only;
o read boundary exige escopo e paridade exata; replay de backfill concluído
revalida chaves e aggregates antes de declarar sucesso; o cutover compara hashes e só
prossegue quando readiness, membership, replay, rollback e políticas externas
estiverem demonstrados. A migration 009 é aditiva e falha fechada para arrays
legados vazios.

## Milestones

### M5 — Control-plane v2 e seam relacional

O milestone só é promovido quando o checker v2 passa, o packet PostgreSQL é
reproduzível, a revisão independente é ligada ao artefato atual e todos os
limites externos continuam visíveis.

## Plan of Work

1. Reconciliar state, backlog, plano, log, verification ledger e gates no
   contrato v2.
2. Reexecutar as validações locais da aplicação e do PostgreSQL depois da
   migração do control-plane.
3. Solicitar crítica read-only fresca em janela delimitada; se indisponível,
   preservar PARTIAL e os blockers.
4. Somente com evidência autorizada, planejar o backfill completo, dual-read,
   EXPLAIN, carga, recuperação e cutover em ambiente-alvo.

## Concrete Steps

<!-- engineering-framework: active_action_id=TASK-V2-RELATIONAL-SAMPLE-LINEAGE-001:RELATIONAL-SAMPLE-LINEAGE-TARGET-EVIDENCE-GATE -->

1. [TASK-V2-RELATIONAL-SAMPLE-LINEAGE-001:RELATIONAL-SAMPLE-LINEAGE-TARGET-EVIDENCE-GATE] Obter evidência de ambiente-alvo para mapeamento relacional completo, dual-read, carga, recovery, rollback e governança; manter o snapshot JSONB como autoridade até aprovação. **Pendente de ambiente e autoridade externos.**
2. [TASK-V2-RELATIONAL-SAMPLE-LINEAGE-001:RELATIONAL-SAMPLE-LINEAGE-COMPLETED-REPLAY-INTEGRITY] Revalidar um run `COMPLETED` contra as chaves e os aggregates relacionais atuais; corrupção posterior deve falhar fechado sem promover autoridade. **Concluído: RED/GREEN real, 9/9 focado, 29/29 completo e 25/25 unit/store.**
3. Implementar backfill PostgreSQL populado por request com checkpoint durável, retomada e reconciliação hash; manter o snapshot JSONB como autoridade. **Concluído localmente.**
4. Exercitar a nova fronteira em PostgreSQL descartável com dado populado, repetição idempotente, interrupção/retomada, concorrência e divergência fail-closed; reexecutar typecheck, lint, validação completa, build, suites de navegador, segurança, performance e recovery. **Concluído: 9/9 focado, 29/29 completo, validate 612/612, E2E 51/51, acessibilidade 6/6, security/perf/recovery verdes; a crítica visual fresca Epicurus retornou `APPROVE` para a matriz local, enquanto os gates de ambiente e autoridade permanecem abertos.**

## Validation and Acceptance

Aceitação local exige checker v2 PASS, JSON/JSONL válidos, plano sem drift de
ação, npm run validate PASS, build PASS, E2E/acessibilidade/security/perf/
recovery PASS, crítica independente sem CRITICAL/HIGH local não resolvido e
packets PostgreSQL focado e completo reproduzíveis. A fatia técnica atual
atende os checks executáveis com PASS_WITH_CONDITIONS; a crítica visual fresca
Epicurus aprovou a matriz local e as tentativas anteriores `NOT_RUN`/condicionais
permanecem históricas. Aceitação de release exige
também as decisões humanas e evidências ambientais listadas nos gates, que ainda
não estão presentes.

## Risks and Human Decisions

Continuam pendentes identidade e ownership hospitalar, política de resultados
críticos, namespace de accession, retenção/residência, backup/RPO/RTO, storage/
malware/secrets, mapeamento relacional completo, dual-read/cutover, carga, CI
remoto, aceitação manual e revisão independente de ambiente-alvo. Risco HIGH e blast radius
SYSTEM permanecem declarados.

## Idempotence and Recovery

A migration e a projeção devem ser repetíveis em cluster descartável sem tocar
DATABASE_URL ou o PostgreSQL existente. Um replay `COMPLETED` também revalida o
target antes de retornar sucesso. Em interrupção, primeiro reconciliar
state e ponteiros; depois repetir somente ações idempotentes e anexar evidência.
O snapshot legado preserva a origem da migração, e nenhum evento histórico é
apagado para esconder falha ou timeout.

## Artifacts and Evidence

As evidências principais são os packets
.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md e
.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md,
seus manifests/saídas brutas, a crítica
.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md,
as migrations 009/010, os adapters/read boundary/cutover/backfill, os testes
PostgreSQL e os ledgers canônicos .agent. O snapshot legado serve apenas para
auditoria da recuperação. A revisão de interface está registrada em
.orchestrate/evidence/v2-patient-workspace-responsive-polish-20260906.md, com
screenshots nativos, ledger visual serializável, relatório de contraste e
packet frontend; o avaliador frontend retorna `CONDITIONAL` honestamente para
as fronteiras manuais/performance ainda não executadas.

- [x] (2026-09-06T12:15:42Z) Revalidação final da fatia Patient Workspace: labels
  de departamento conhecidos/desconhecidos, wrapping do owner e capturas 188/320/375,
  loading, pagination-loading e long-copy ficaram sincronizados; domínio/componente
  passaram 19/19, `npm run validate` 569/569, build com 12 rotas, E2E completo sem
  retry 51/51, security/audit/perf/recovery verdes; Wegener confirmou em nova leitura
  independente que os achados visuais foram fechados, mantendo o ledger
  `REVIEW REQUIRED`/condicional para manual, alvo/produção, golden, clínico, humano e AAA.
- [x] (2026-09-06T13:36:39Z) Revalidação corrente após hardening do lane
  `browser-postgres`, retries explícitos zero e falha fechada do runtime externo:
  coverage 570/570 (93,07/85,12/95,51), build 12 rotas, docs 73 arquivos,
  OpenAPI 65/60, traceability 43/43, migrations, typecheck/lint, security/audit,
  performance 7/7, recovery 5/5 e E2E 51/51 verdes. O critic independente fresco
  expirou sem relatório; ledger e pacote visual permanecem `REVIEW REQUIRED`/
  condicional, sem promoção a AAA ou produção.
- [x] (2026-09-06T15:51:30Z) Revalidação G4 ampla do working tree: `npm run
  test:coverage` passou 612/612 em 75 arquivos, com 92,04% statements/lines,
  85,02% branches e 94,43% functions no escopo executável de app, domínio,
  runtime, persistência e UI; typecheck, lint, docs 73, OpenAPI 65/60,
  traceability 43/43, migrations 001–010, security/audit, build 12 rotas,
  performance 7/7, recovery 5/5 e E2E sem retry 51/51 com acessibilidade 6/6
  também passaram. O packet [`aaa3-g4-broad-coverage-20260906.md`](../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md)
  fixa o denominador, exit codes, hashes e fingerprint; o candidato continua
  local/condicional porque JSONB é a autoridade runtime, a revisão visual
  independente está `BLOCKED` e os gates de ambiente, cutover, recovery,
  políticas humanas, hospital e release continuam abertos.
- [x] (2026-09-06T16:34:07Z) Revalidação G4 ampla final do working tree com a
  política serial oficial do Vitest: `npm run validate` passou integralmente;
  `npm run test:coverage` passou 612/612 em 75 arquivos, 92,01% statements/lines,
  85,03% no artefato corrente de branches (piso observado 85,02% em repetições)
  e 94,43% functions; docs 73, OpenAPI 65/60, traceability 43/43,
  migrations 001–010, typecheck, lint e a política de cobertura ampla passaram.
  O packet G4 foi atualizado com o hash do artefato, a política de execução e
  o fingerprint atual. O estado segue local/condicional: JSONB permanece
  autoridade runtime, a crítica visual independente está `BLOCKED` e os gates
  de ambiente-alvo, cutover, recovery, políticas humanas, hospital e release
  continuam abertos.
- [x] (2026-09-06T18:52:09Z) Fechamento do pacote visual local: o cenário
  responsivo agora captura ready/loading/error-denied/empty/partial/stale em
  1440/834/375 CSS px, com 18 PNGs, hashes e dimensões no manifest; a crítica
  fresca e selada de Hooke retornou `APPROVE`, e a matriz E2E final passou
  51/51 sem retry. VIS-004/VIS-014 fecham no escopo local; manual,
  golden/alvo-produção, autoridade relacional, clínico e humano continuam
  explicitamente abertos.
- [x] (2026-09-06T19:42:36Z) Revalidação final após o polish responsivo: o
  foco passou 3/3 e sincronizou a matriz final de 18 PNGs; Epicurus, em contexto
  fresco e somente leitura, retornou `APPROVE` sem defeito visual local material;
  E2E completo isolado passou 51/51 em 4,6 minutos sem retry e `npm run validate`
  passou 612/612, docs 73/73, OpenAPI 65/60, traceability 43/43 e migrations
  001–010. O estado permanece VERIFY/PARTIAL por causa de CI remoto, ambiente-
  alvo, cutover relacional, revisão manual, políticas clínicas e autoridade de
  release ainda ausentes.
- [x] (2026-09-06T21:14:42Z) Revalidação final da rodada visual v6: o foco responsivo passou 3/3 e a suíte E2E completa passou 51/51 em 3,9 minutos, sem retry, com acessibilidade 6/6; `npm run validate` passou 614/614 em 75 arquivos, cobertura 92,01/85,00/94,36, docs 73/73, OpenAPI 65/60, traceability 43/43 e migrations 001–010. O packet v6 contém 20 PNGs em 1440/834/375, incluindo timeline densa colapsada/expandida; Bernoulli fez crítica independente fresca e retornou `APPROVED_LOCAL`. O loading mobile foi estabilizado antes da captura. A nova integração PostgreSQL de recoleta/rollback permanece NOT_RUN por falta de cluster descartável; o 5432 persistente não foi tocado. O estado permanece VERIFY/PARTIAL por CI/ambiente alvo, autoridade relacional/cutover, recovery, revisão manual, políticas clínicas e autoridade de release.
- [x] (2026-09-06T21:36:00Z) Reconciliação final dos packets e do status: `npm run validate:docs` passou 73/73 e `git diff --check` passou; os documentos correntes apontam para o packet v6 de 20 artefatos e para 614/614 (92,01/85,00/94,36), enquanto snapshots de 18 artefatos/612 testes ficaram explicitamente históricos. A integração PostgreSQL nova continua NOT_RUN sem runtime descartável; o 5432 persistente não foi tocado. Estado mantido em VERIFY/PARTIAL.
