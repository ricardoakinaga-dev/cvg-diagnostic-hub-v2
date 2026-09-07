# AAA-2 G4 — crítica independente do estado atual

**Data/hora da revisão:** 2026-09-05T11:08:00-03:00  
**Escopo:** working tree atual em `/home/ricardo/cvg-diagnostic-hub-v2`  
**Commit observado:** `01bb1804682b4bb503e00e41c1361dc704d2294d`  
**Runtime observado:** Node `v24.20.0`, npm `11.19.0`; alvo declarado pelo repositório: Node 22  
**Veredito global:** **REJECT / NÃO PRONTO PARA G4**

## Independência e método

Esta é uma revisão nova do working tree corrente. Li `docs/build/AAA_2_QUALITY_BAR.md`, `AAA_2_EXECUTIVE_PLAN.md`, `AAA_2_ROADMAP.md`, `AAA_2_BACKLOG.md`, a matriz de rastreabilidade, o registro de decisões e os arquivos de implementação/teste alterados das fatias recentes. Não usei os packets G0–G3 como prova de aceitação; eles só foram consultados para entender a cronologia declarada pelos documentos.

Não alterei produto, testes ou documentação existente. Este arquivo é o único artefato produzido por esta crítica. O checkout permanece deliberadamente sujo, com alterações staged/unstaged e arquivos não rastreados; portanto não há candidato imutável nem hash de working tree limpo para aceite final.

## Execução reproduzida

| Comando | Resultado observado | Interpretação G4 |
| --- | --- | --- |
| `npm test` | **PASS**, 59 arquivos / 489 testes | Regressão local verde; não prova E2, PG ou operação distribuída. |
| `npm run test:coverage` | **PASS**, 92,61% statements/lines, 85,35% branches, 95,15% functions | O limiar agregado local de 85% branches passa nesta execução. O número documental 85,37% difere em 0,02 ponto; a execução atual é a fonte deste packet. Há módulos com lacunas, inclusive contrato de storage sem execução e adaptador relacional parcialmente coberto. |
| `npx vitest run src/components/result-view.test.tsx` | **PASS**, 11/11 | Inclui a sentinela de resposta realtime antiga que resolve depois da nova. É prova local de componente, não fanout entre instâncias. |
| Foco AAA2-022 (`admission-context-service`, rota, schemas, contratos e OpenAPI runtime) | **PASS**, 42 testes / 6 arquivos | Prova a fronteira server-side policy-gated; D-01, UI, notificação/delegação, PG e aceite clínico continuam abertos. |
| Foco AAA2-029 (`sla-policy` + `service`) | **PASS**, 20 testes / 2 arquivos | Prova fallback/calculadora local; não implementa a política operacional aprovada, persistência/admin ou job durável. |
| `npm run typecheck` | **PASS** | Executado sob Node 24; não substitui execução completa no Node 22 alvo. |
| `npm run lint` | **PASS** | Sem erro observado. |
| `npm run build` | **PASS**, Next.js 16.3.0, 11 páginas estáticas | Build local verde; a configuração E2E continua usando servidores de desenvolvimento e memória sintética. |
| `npm run validate:docs` | **PASS**, 56 arquivos/gates | Validação estrutural verde; há divergência factual residual em artefato G0 e precisão de cobertura documentada. |
| `npm run validate:openapi` | **PASS**, 65 operações / 60 paths | Manifesto e documento OpenAPI convergem localmente. |
| `npm run validate:migrations` | **PASS**, versões 001–008 e checksums | Valida arquivos/manifesto; não executa constraints, índices, rollback ou cutover em PostgreSQL vivo. |
| `npm run security:scan` | **PASS** | Nenhum padrão de segredo versionável encontrado. |
| `npm audit --audit-level=high --json` | **PASS**, 0 vulnerabilidades em todas as severidades | Scan de dependências não prova threat model, configuração de produção ou segurança clínica. |
| `node --test scripts/validate-traceability.test.mjs` | **PASS**, 4/4 testes do validador | O validador detecta corretamente ausência de evidência. |
| `npm run validate:traceability` | **FAIL CLOSED**, 16 issues | Falha correta para FR-OPS-002, NFR-PERF-001, NFR-PERF-002 e NFR-OPS-001; quatro referências ausentes por requisito. Este gate não é PASS. |
| `npm run test:postgres` | **BLOCKED/FAIL**, 10 integrações falham no guard por ausência de `ALLOW_POSTGRES_INTEGRATION_TESTS=true`/URL PG; 6 testes do harness passam | Não houve teste PostgreSQL. As dez integrações não contam como aprovação. |
| `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | **PASS**, 45/45 em 2,8 min, Chromium/tablet/mobile, sem retry | Evidência browser sintética: servidores Next isolados por projeto, `APP_DATA_MODE=memory`; não é E2/homologação durável. |
| `npm run test:accessibility` | **PASS**, 6/6 em Chromium/tablet/mobile | Axe/keyboard automatizado passa; não substitui revisão manual de leitor de tela, touch real, contraste/zoom/reduced motion nem aceite hospitalar. |
| `git diff --check` | **PASS** | Não encontrei whitespace error; o working tree continua não congelado. |

## Inspeção de autoridade e limites

- `db/migrations/007_relational_clinical_core.sql` é aditiva e declara que o runtime ainda é autoritativo em `cvg_runtime_state`.
- `src/server/store/postgres-store.ts` continua lendo e atualizando `cvg_runtime_state`/estado JSONB; o adaptador relacional é uma sombra/transição e não fecha AAA-08.
- `src/server/observability/realtime.ts` oferece somente o adaptador `process-local`; não há fanout/broker comprovado para duas instâncias.
- AAA2-022 falha fechada em `503 ADMISSION_CONTEXT_POLICY_UNAVAILABLE` sem D-01. Isso é comportamento seguro da fatia local, não aprovação da política de identidade/transferência.
- AAA2-029 mantém `LEGACY_SERVICE_FALLBACK` com calendário contínuo e sem pausas autorizadas; D-04, calendário clínico, persistência, administração, histórico e overdue durável permanecem abertos.
- O browser atual cobre memória sintética. Não há browser contra PostgreSQL, carga representativa, `EXPLAIN`, duas instâncias reais, restore de banco/anexos/configuração, CI remoto ou revisão/aceite manual.
- D-01, D-02, D-03, D-04, D-05 e D-06 continuam `OPEN`; o registro não nomeia decisores humanos aprovadores.
- O documento G0 atual ainda contém a narrativa antiga de 20 issues na linha 29, enquanto a execução corrente e o arquivo `aaa2-traceability-current-20260905.txt` mostram 16. Os documentos correntes também registram 85,37% branches, enquanto esta execução reproduziu 85,35%. `validate:docs` não verifica a semântica desses números. Essa inconsistência afeta a confiabilidade do pacote de evidência, embora não mude o veredito global já bloqueado por gates maiores.

## Veredito por critério AAA

O critério abaixo só recebe PASS quando a exigência integral da barra é demonstrada. PASS local de teste não é convertido em PASS de aceite.

| Critério | Veredito | Evidência atual e motivo da rejeição |
| --- | --- | --- |
| AAA-01 — jornadas | **REJECT** | 45/45 cobre jornadas sintéticas principais, mas não demonstra transferência/alta completa, política hospitalar, UI correspondente, E2 com banco durável ou validação humana E3. |
| AAA-02 — HTTP | **REJECT** | OpenAPI 65/60 e contratos locais passam, porém paridade semântica integral, políticas restantes e rastreabilidade completa não estão fechadas. |
| AAA-03 — entradas | **REJECT** | Limites de corpo/header/proxy e rate limit têm testes locais; não há abuso E2, pressão de recursos ou ambiente de homologação equivalente. |
| AAA-04 — autorização | **REJECT** | Escopo, cancelamento, sessão e gestor delegado têm negativos locais; revogação e limites entre duas instâncias, identidade institucional e D-01 permanecem sem prova. |
| AAA-05 — confidencialidade | **REJECT** | Negativos de leitura/draft/SSE existem localmente; falta comprovação durável multi-instância, telemetria em ambiente alvo, anexos e aceites de operação. |
| AAA-06 — identidade clínica | **REJECT** | Registro/encounter/admission e a fronteira de contexto existem localmente, mas homônimo, ownership, transferência/alta e referência institucional dependem de D-01 aberta. |
| AAA-07 — lifecycle | **REJECT** | Invariantes e concorrência sintética cobrem partes do ciclo; D-02, banco relacional autoritativo, corrida entre processos e replay durável não foram demonstrados. |
| AAA-08 — persistência | **REJECT** | A migration relacional é shadow; o runtime continua JSONB em `cvg_runtime_state`. Não há cutover, constraints/índices exercitados nem SQL/EXPLAIN em banco vivo. |
| AAA-09 — migração | **REJECT** | Manifesto/checksums/backfill local passam, mas bootstrap/upgrade populado, falha intermediária, rollback/roll-forward e reconciliação no PG não foram executados. |
| AAA-10 — multi-instância | **REJECT** | As 10 integrações PG são bloqueadas pelo guard e o realtime é process-local; sessões, limites, dados e revogação entre instâncias não estão comprovados. |
| AAA-11 — delivery | **REJECT** | Envelope, sink, lease, dedupe e poison têm testes locais; durabilidade transacional, dois workers, crash após publicação e confirmação em PG não foram exercitados. |
| AAA-12 — realtime | **REJECT** | ResultView tem 11 testes e E2E passa; falta fanout multi-instância, dois usuários/servidores, replay Last-Event-ID durável, expiração e orçamento operacional de polling. |
| AAA-13 — arquivos | **REJECT** | Limites/checksum/scanner e adapters locais passam; scanner/storage externos, quarentena em homologação e restore verificável de bytes/metadados permanecem ausentes. |
| AAA-14 — observabilidade | **REJECT** | Readiness, correlação e métricas bounded estão cobertos; alerta acionável recebido, injeção de falha, runbook e dono operacional não foram demonstrados. |
| AAA-15 — desempenho | **REJECT** | Não há cadeia executável para NFR-PERF-001/002; faltam workload aprovado, PG, EXPLAIN, p50/p95/p99, throughput, pico e soak. |
| AAA-16 — UX | **REJECT** | Axe e teclado automatizados passam em seis casos; estados completos, touch/leitor/contraste/zoom/reduced motion manuais, usuários e condições reais não foram aceitos. |
| AAA-17 — arquitetura | **REJECT** | Fitness acíclico e fronteiras locais passam; revisão final/threat model independente, coesão dos módulos e integração no candidato final ainda estão em AAA2-051/CI. |
| AAA-18 — cadeia e build | **REJECT** | Build, lint, audit e secret scan passam; execução corrente usa Node 24 contra alvo Node 22, checkout está sujo e CI remoto/retenção/proveniência do candidato não foram comprovados. |
| AAA-19 — recuperação | **REJECT** | Não houve restore durável de banco + anexos + configuração/chaves nem medição RPO/RTO; NFR-OPS-001 é uma das quatro lacunas do validador. |
| AAA-20 — rastreabilidade | **REJECT** | `validate:traceability` falha fechado com 16 issues em quatro requisitos. A matriz ainda não liga todo MUST/AC a código, teste, comando e evidência atual. |
| AAA-21 — governança | **REJECT** | Todas as decisões D-01–D-05 necessárias seguem `OPEN`, sem decisores nomeados, assinatura, versão e vigência; fatias policy-gated não equivalem a aprovação. |
| AAA-22 — release | **REJECT** | Não há E4: D-06, CI remoto, revisão final, treino, piloto, rollback exercitado, parecer formal ou decisão de release. |

## Falhas e severidade

| Severidade | Achado | Critérios afetados | Condição de fechamento |
| --- | --- | --- | --- |
| **BLOCKER / crítico** | A fonte clínica de runtime permanece snapshot JSONB; PG relacional/cutover/constraints/concorrência não foram executados. | AAA-08, 09, 10, 11, 15, 19, 20 | Ambiente PostgreSQL descartável, cutover reconciliado, duas instâncias, SQL/EXPLAIN, recovery e evidência reproduzível. |
| **BLOCKER / alto** | Rastreabilidade falha fechado com 16 referências ausentes em FR-OPS-002, NFR-PERF-001/002 e NFR-OPS-001. | AAA-15, 19, 20 | Código, teste, comando local e evidência atual para cada AC; revisão semântica sem placeholders. |
| **BLOCKER / alto** | D-01–D-06 continuam abertas; não há política institucional aprovada nem aceite E3/E4. | AAA-01, 06, 07, 14, 16, 21, 22 | Decisores nomeados, políticas versionadas/assinadas, revisão manual, treinamento, piloto e decisão formal. |
| **ALTO** | Realtime tem adapter somente process-local; fanout e revogação multi-instância não têm prova. | AAA-04, 05, 10, 12, 14, 15 | Broker/transport durável, duas instâncias, replay/resync, cliente lento, revogação e métricas em homologação. |
| **ALTO** | Restore, workload/performance, soak e RPO/RTO não demonstrados; browser atual é sintético em memória. | AAA-01, 09, 13, 15, 19, 22 | Ensaios com ambiente alvo, dados representativos, anexos/configuração, métricas aprovadas e revisão independente. |
| **MÉDIO** | Evidência documental corrente diverge: G0 ainda diz 20 issues e documentos registram 85,37%, enquanto a execução corrente mostra 16 e 85,35%. | AAA-18, 20 | Atualizar o artefato de controle com saída datada atual e preservar a distinção histórica. |

## Decisão

O branch gate local de cobertura está aprovado nesta execução, e os testes locais, contratos, build, scans, OpenAPI, migrations e browser sintético têm resultados reproduzíveis. Isso não satisfaz a barra: o requisito de G4 exige todos os AAA-01–AAA-21, rastreabilidade completa, ambiente durável, prova de persistência relacional, operação distribuída, recovery/performance e decisões humanas. O veredito independente para o estado atual é **REJECT / NÃO PRONTO**.

