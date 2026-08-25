# CVG Diagnostic Hub V2 — mapa de migração e reúso

## Propósito

Este documento separa o que existe no checkout local, que veio da linha V1, do
que será a arquitetura-alvo do V2. O repositório oficial configurado em `origin`
é `https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2`; a linha V1 foi
preservada no remote local `v1` e no histórico Git. O remote oficial V2 estava
vazio no momento da descoberta, portanto o checkout atual é uma base de
transição, não uma prova de que a migração já ocorreu.

## Princípios de migração

- V1 continua disponível durante a evolução; não há remoção destrutiva nem
  reescrita sem uma fronteira executável.
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
| Persistência/migrações | `src/server/store`, `db/migrations` | ADAPTAR e encapsular | `packages/database` + `apps/api` | não declarar modelo relacional concluído enquanto for snapshot transitório |
| Constantes e utilitários | `src/lib`, `src/server/*` | CLASSIFICAR por dependência | `packages/constants`/`utils`/`domain` | sem mover código clínico para utilitário genérico |
| Laboratório | itens/serviços existentes e uma fixture Hemograma com template estruturado | ADAPTAR verticalmente, depois MOVER | `apps/web/features/laboratory`, `apps/api/src/modules/laboratory` | amostras, analitos, faixas aprovadas, criticidade e recoleta reais |
| Radiologia/ultrassom | workflows de imaging existentes | SEPARAR regras | `features/radiology`, `features/ultrasound` e módulos API | não colapsar modalidades em um status genérico |
| Resultados/notificações | serviços e telas existentes | REUSAR invariantes, ampliar lifecycle | `features/results`, `features/notifications` | revisão, versão, crítico, acknowledgement e realtime |
| Documentação/evidência | `docs/*`, `.agent`, `.gauntlet` | PRESERVAR histórico e adicionar V2 | `docs/v2/*` + control plane | claims atuais devem apontar para evidência fresca |

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

- A linha V1 não é apagada e o histórico continua navegável.
- Rotas e comandos existentes não ganham transições genéricas de status.
- Escopo de departamento e autorização continuam sendo decididos no servidor.
- Dados sintéticos permanecem identificáveis como sintéticos; nenhum dado real é
  introduzido.
- A cada onda, typecheck, lint, build e os testes regressivos são executados com
  o runtime Node compatível disponível no ambiente.
