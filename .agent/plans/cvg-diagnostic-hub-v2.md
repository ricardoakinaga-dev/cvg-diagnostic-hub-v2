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

- **Stage:** VERIFY/AUDIT concluído condicionalmente para a fatia Laboratório
  estruturado, após correção do release legado, do catálogo e da paridade de
  contrato; próxima fatia: Patient Workspace.
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
- The slice remains conditional because thresholds/critical behavior,
  sample/accession linkage, relational persistence, Patient Workspace and
  clinical acceptance are not implemented or approved.
