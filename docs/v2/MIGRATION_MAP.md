# CVG Diagnostic Hub V2 — mapa de migração e reúso

## Propósito

Este documento separa o que existe no checkout local, que veio da linha V1, do
que será a arquitetura-alvo do V2. O repositório configurado em `origin` é
`https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2`. Na inspeção de
04/09/2026, `origin` era o único remote configurado e as refs visíveis eram
`main`, `origin/main` e `origin/HEAD`; não há remote nem ref local `v1` neste
checkout. Portanto, a preservação da linha V1 não é verificável como remote/ref
atual e não deve ser apresentada como tal.

Registro histórico superseded: versões anteriores deste mapa afirmavam que a
linha V1 estava preservada em um remote local `v1` e que o remote V2 estava vazio.
Essas afirmações permanecem apenas como contexto histórico; a inspeção atual não
as confirma. A base corrente deve ser tratada como transição até que a
preservação V1 seja demonstrada por evidência Git verificável.

**AAA-1:** [barra](../build/STATE_OF_ART_QUALITY_BAR.md) · [plano](../build/EXECUTIVE_IMPROVEMENT_PLAN.md) · [roadmap](../build/STATE_OF_ART_ROADMAP.md) · [backlog](../build/STATE_OF_ART_BACKLOG.md) · [auditoria de 04/09/2026](../PROJECT_STATUS_REPORT.md)

## Princípios de migração

- A evolução deve preservar a linha V1; não há remoção destrutiva nem reescrita
  sem uma fronteira executável. A disponibilidade atual de V1 precisa ser
  confirmada por uma ref/artefato Git verificável, ausente nesta inspeção.
- O runtime e os testes atuais são a verdade do comportamento; documentação
  antiga é evidência de intenção e será reconciliada quando divergir.
- A migração será feita por fatias verticais. Cada fatia precisa atravessar
  domínio, persistência/leitura, contrato HTTP, autorização, UI, estados de
  carregamento/erro/vazio e testes aplicáveis.
- O V2 adotará modular monolith. Packages existem para fronteiras reais e
  reutilizáveis, não para fragmentar cada abstração.
- O Plane foi estudado somente como referência de composição de produto. Não
  são copiados branding, código, nomes, rotas ou arquitetura proprietária.

## Mapa atual → alvo

| Área atual | Evidência local | Decisão V2 | Destino-alvo | Risco/critério |
| --- | --- | --- | --- | --- |
| Aplicação Next | `src/app`, páginas e `src/components` | ADAPTAR e depois MOVER | `apps/web/app` + `apps/web/features` | preservar rotas e journeys durante a mudança |
| Shell clínico | `src/components/app-shell.tsx` | REFAZER incrementalmente | `apps/web/app/shell` + `packages/ui` | navegação persistente, escopo por permissão, teclado e responsividade |
| API HTTP | `src/app/api/v1/[...path]/route.ts` | ADAPTAR e extrair | `apps/api/src/http` | uma única fronteira de autorização, schema e envelope |
| Aplicação de domínio | `src/server/application/*` | REORGANIZAR por bounded context | `apps/api/src/modules/*` | evitar dependência entre módulos por tabelas/estado privado |
| Modelos e state machine | `src/server/domain/*` | REUSAR regras, mover aos poucos | `packages/domain` | state transitions e next action puros e testáveis |
| Contratos | `packages/contracts/src/index.ts` | REUSAR e ampliar | `packages/contracts` | contrato runtime/OpenAPI/testes devem permanecer alinhados |
| Componentes visuais | `src/components`, `src/app/globals.css` | ADAPTAR e consolidar | `packages/ui` + tokens | primitives acessíveis antes de componentes clínicos |
| Serviços HTTP/clientes | fetches espalhados nos componentes | EXTRAIR | `packages/services` | componentes não devem conhecer envelopes ou headers arbitrários |
| Estado local de UI | estado React distribuído | EXTRAIR somente o compartilhado | `packages/shared-state` | seleção, drawer, preferências e filtros; dados clínicos continuam server-owned |
| Autenticação/autorização | `src/server/security/*` | REUSAR invariantes, mover adaptadores | `packages/auth` + `apps/api` | autorização permanece server-side e fail-closed |
| Persistência/migrações | `src/server/store`, `db/migrations` | ADAPTAR e encapsular; manter seam relacional 007–010 em shadow | `packages/database` + `apps/api` | JSONB continua autoridade; o backfill request-scoped de 010 é apenas shadow local até mapeamento completo, dual-write, cutover e aprovação operacional; não declarar migração concluída |
| Constantes e utilitários | `src/lib`, `src/server/*` | CLASSIFICAR por dependência | `packages/constants`/`utils`/`domain` | sem mover código clínico para utilitário genérico |
| Laboratório | itens/serviços existentes e uma fixture Hemograma com template estruturado | ADAPTAR verticalmente, depois MOVER | `apps/web/features/laboratory`, `apps/api/src/modules/laboratory` | amostras, analitos, faixas aprovadas, criticidade e recoleta reais |
| Radiologia/ultrassom | workflows de imaging existentes | SEPARAR regras | `features/radiology`, `features/ultrasound` e módulos API | não colapsar modalidades em um status genérico |
| Resultados/notificações | serviços e telas existentes | REUSAR invariantes, ampliar lifecycle | `features/results`, `features/notifications` | revisão, versão, crítico, acknowledgement e realtime |
| Documentação/evidência | `docs/*`, `.agent`, `.gauntlet` | PRESERVAR histórico e adicionar V2 | `docs/v2/*` + control plane | claims atuais devem apontar para evidência fresca |

### Patient Workspace — primeira fatia contextual

O workspace contextual é a próxima fatia clínica incremental. A rota atual
`GET /patients/{patientId}/diagnostics` permanece o boundary compatível; sua
propriedade `workspace` é uma projeção server-owned que reúne identidade,
encounter/admission, requests, items, OperationalContext e resumos autorizados
de sample/result/attachment. O contrato congelado, a matriz de escopo e a barra
de jornada estão em [`PATIENT_WORKSPACE.md`](PATIENT_WORKSPACE.md).

Não haverá cópia de status no browser nem atalho para conteúdo clínico completo:
resultado e download continuam nos endpoints protegidos existentes. A migração
posterior para `apps/web`/`apps/api` deve preservar esse shape e seus testes de
não vazamento antes de separar bounded contexts.

## Primeira fatia vertical

O primeiro corte será a projeção operacional compartilhada pelo Dashboard e pela
Central de Exames:

```text
state/domain rules
  → read model/API contract
  → server-side scope
  → Command Center attention-first
  → Central de Exames list/filter/context drawer
  → domain/API/component/regression tests
```

Ela fecha a lacuna mais visível entre o produto atual e o objetivo V2: a fila já
possui uma string de `nextAction`, mas não expõe de forma estruturada o dono
atual, bloqueio, espera, prazo e escalonamento operacional. A implementação não
inventará política clínica: escalonamento será uma classificação operacional
derivada de prioridade/SLA existentes, e decisões de limiar, destinatário e
fallback continuarão gates humanos explícitos.

## Segunda fatia vertical — Laboratório estruturado

A fatia seguinte executa um Hemograma sintético no lifecycle já existente:

```text
template de painel versionado
  → observações tipadas e validação server-side
  → snapshot de faixa/flag
  → draft/release/amend/review
  → editor/tabela de analitos
  → contrato OpenAPI, escopo e jornada browser
```

Ela está documentada em `docs/v2/LABORATORY_VERTICAL.md`. A fixture não contém
thresholds clínicos; toda faixa de referência está pendente de aprovação humana,
e a ausência de criticidade/fallback continua deliberada.

## Terceira fatia vertical — núcleo relacional e linhagem de amostras

A fatia relacional atual transforma o contrato de sample/accession em uma seam
verificável, sem fingir que o cutover já ocorreu:

```text
workflow de amostra/recoleta
  → accession canônico e predecessor versionado
  → tabelas relacionais 007–009 e links derivados
  → adapter/read model/cutover fail-closed
  → projeção de agenda com optimistic concurrency
  → testes de escopo, ciclo, duplicidade, órfão e contrato
```

O contrato detalhado está em [`RELATIONAL_SAMPLE_LINEAGE.md`](RELATIONAL_SAMPLE_LINEAGE.md).
As migrations 007–010, o adapter, o read model, o backfill request-scoped e a
integração PostgreSQL descartável são evidência local; os packets estão em
[`v2-relational-sample-lineage-postgres-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md).
O [packet do backfill](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md)
e a [crítica independente](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md)
registram a fatia populada local. O runtime JSONB permanece a autoridade, não
há dual-write/cutover autorizado e a validação PostgreSQL de ambiente-alvo continua pendente. A
política de accession, recoleta, status de link e preservação histórica exige
aprovação humana antes de qualquer mudança de autoridade ou namespace clínico.

## Ordem de ondas

1. **Fundação e projeção operacional:** `packages/domain`, contratos, read model,
   Command Center e drawer da fila.
2. **Fronteira de packages:** `packages/ui`, `services`, `shared-state`, `auth`,
  `database` com imports reais, não diretórios vazios.
3. **Laboratório estruturado:** template, observações tipadas, lifecycle,
   contrato, editor e jornada sintética, mantendo o boundary transitório.
4. **Workspace web/API:** mover o runtime para `apps/web` e `apps/api` por
  compatibilidade verificável, mantendo a API V1 durante a transição.
5. **Domínios clínicos profundos:** Patient Workspace, Laboratory completo,
   Radiology, Ultrasound, Results e Notifications com jornadas completas.
6. **Hardening e operação:** realtime/degraded state, observabilidade, migração
  relacional, carga representativa, acessibilidade e auditoria independente.

## Critérios de não-regressão

- A linha V1 não deve ser apagada e o histórico deve continuar navegável; esse
  critério não está comprovado por um remote/ref `v1` no checkout atual.
- Rotas e comandos existentes não ganham transições genéricas de status.
- Escopo de departamento e autorização continuam sendo decididos no servidor.
- Dados sintéticos permanecem identificáveis como sintéticos; nenhum dado real é
  introduzido.
- A cada onda, typecheck, lint, build e os testes regressivos são executados com
  o runtime Node compatível disponível no ambiente.
