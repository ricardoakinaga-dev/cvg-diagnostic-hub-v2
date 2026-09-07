# Relatório de auditoria — CVG Diagnostics Hub V2

**Data:** 07/09/2026  
**Escopo:** corpus completo de docs/, código, runtime, testes, configuração, migrations, CI e evidências locais disponíveis no working tree.  
**Classificação:** auditoria técnica e documental local; não é aprovação clínica, hospitalar ou produtiva.

## 1. Veredito executivo

- **Maturidade técnica local:** **87/100**.
- **Prontidão para produção hospitalar/clínica:** **45/100**.
- **Estado:** candidato local tecnicamente forte, com **CONDITIONAL PASS** da evidência automatizada; continua **NOT READY** para produção ou uso clínico real.

A média local não compensa falhas obrigatórias. A barra AAA exige critérios técnicos, operacionais, humanos e hospitalares completos; portanto, a nota não autoriza release nem aprovação clínica.

## 2. Corpus documental

Foram percorridos **82 arquivos em docs/**: 81 Markdown e o contrato `api/openapi.json`. O corpus cobre discovery, PRD, domínio, estados, permissões, dados, API, arquitetura, UX, segurança, testes, operações, build, V2, ADRs, rastreabilidade e auditorias anteriores. O OpenAPI foi carregado e validado estruturalmente.

Há números históricos concorrentes em documentos legados (614/619 testes e packets anteriores). Eles permanecem identificados como histórico; para esta auditoria, a fonte corrente é o manifesto de evidências [`evidence-manifest.json`](../.orchestrate/aaa3-execution-20260907/evidence-manifest.json), o packet de revalidação corrente, o quality bar congelado e os comandos reproduzidos abaixo.

## 3. O que já está construído

O sistema possui:

- login, sessão, CSRF, RBAC, escopo por paciente/setor e reautenticação;
- cadastro de pacientes, atendimentos e internações;
- solicitações multi-item, duplicidade, prioridade, cancelamento e filas paginadas;
- workflows de Laboratório, Radiologia/RX e Ultrassonografia;
- amostras, accession, recoleta e lineage relacional em modo shadow;
- resultados versionados: draft, release, revisão, emenda e invalidação;
- upload, checksum, validação MIME, quarentena e download privado;
- notificações, outbox com retry/lease e realtime SSE com replay/fallback;
- busca, timeline, dashboard, indicadores e auditoria;
- interfaces para login, dashboard, filas, pacientes, Patient Workspace, resultados, notificações, administração e indicadores;
- MemoryStore e PostgresStore, com bloqueio de memória em produção;
- API com 65 operações em 60 paths e 187 schemas OpenAPI;
- migrations PostgreSQL 001–010;
- packages reais para contratos, domínio, UI, serviços e estado compartilhado.
- hardening recente de autorização para emenda/invalidação, escopo de internação e recoleta sem oracle de estado;
- scanner externo com allowlist exata de host, validação de URL/IP e redirect fail-closed;
- realtime que reprocessa somente eventos `PENDING`/`PROCESSED` e suprime `PROCESSING`/`FAILED`;
- logger HTTP estruturado com allowlist, redaction de campos sensíveis, correlação e limites de cardinalidade;
- relatório de cobertura por camada e SBOM CycloneDX publicado no CI;
- runbooks locais de incidente, outbox, storage/scanner, realtime, segurança e fechamento;
- navegação mobile orientada pela URL, logout acessível em breakpoint compacto, cards de fila até 960px e superfícies de ação acima da navegação fixa;
- matriz visual renovada com 20 capturas nos estados ready, loading, empty, partial, stale, error-denied, dense-collapsed e dense-expanded.

O runtime relacional ainda não é a autoridade clínica. O PostgresStore mantém o snapshot JSONB como fonte de verdade, enquanto a projeção relacional permanece shadow-only.

## 4. Evidência executada nesta auditoria

| Verificação | Resultado |
| --- | ---: |
| TypeScript | PASS |
| ESLint | PASS |
| Build Next.js | PASS; Next.js 16.3.0/Turbopack, 15 rotas da aplicação (11 estáticas e 4 dinâmicas) |
| Testes com cobertura | 725/725 em 86 arquivos |
| Cobertura | 92,72% statements/lines, 85,82% branches, 94,31% functions na execução full corrente |
| E2E fluxo principal | 36/36, sem retry, Chromium/tablet/mobile |
| E2E ciclo clínico | 9/9, sem retry, Chromium/tablet/mobile |
| Acessibilidade automatizada | 12/12, sem violações Axe nas rotas administrativas, de gestão e clínicas |
| E2E matriz completa | 60/60, sem retry, Chromium/tablet/mobile; inclui realtime |
| Performance unitária | 7/7 |
| Recovery contratual | 5/5 |
| OpenAPI | 65 operações / 60 paths |
| Rastreabilidade | 43 requisitos e 43 critérios vinculados |
| Migrations | PASS estrutural/checksum, 001–010; packet PostgreSQL descartável anterior 39/39 em 6 arquivos, incluindo upgrade 001→010 SAA-022; a repetição corrente foi bloqueada por ausência de `initdb`/`pg_ctl`/Docker e não tocou 5432; autoridade/backfill produtivo/reconciliação de cutover continuam fora do escopo |
| Lane browser production-like local | PASS; 51/51 sem retry em Chromium/tablet/mobile contra `next start`, PostgreSQL, S3/scanner sintéticos e worker outbox durável |
| Restore smoke local | PASS condicional; dump/checksum e restauração PostgreSQL-only em banco isolado, sem restore de object storage, configuração/chaves ou RPO/RTO aprovado |
| Secret scan | PASS |
| npm audit (produção) | 0 vulnerabilidades; auditoria completa revalidada nesta rodada |
| SBOM | PASS; CycloneDX 1.5 com 560 componentes sob Node 22, JSON validado e artefato previsto no CI |
| Performance sintética | PASS, workload determinístico |
| Integridade de diff | `git diff --check` PASS |

A performance sintética usa relógio e dataset determinísticos; não comprova carga hospitalar, PostgreSQL sob concorrência, CPU, rede, soak test ou failover. Os testes de navegador confirmam o comportamento local da aplicação, mas não substituem aceite manual de touch, leitor de tela, workflow clínico e ambiente hospitalar.

A evidência PostgreSQL descartável anterior registra **39/39 testes PASS em 6 arquivos** em PostgreSQL 16.15, incluindo o upgrade populado `001→010` do SAA-022 e a retomada após `009` já aplicado; o cluster foi encerrado ao final e a instância persistente em `127.0.0.1:5432` não foi usada. A repetição desta rodada não foi contabilizada porque o host não disponibiliza `initdb`/`pg_ctl` e não possui Docker; a tentativa ficou em `ECONNREFUSED` antes de aplicar migration e está documentada no [packet de condição de ambiente](../.orchestrate/aaa3-execution-20260907/postgres-current-rerun-node22-20260907.md). O [packet final Node 22](../.orchestrate/aaa3-execution-20260907/node22-current-revalidation-a11y-20260907.md) registra a execução; o [packet específico de upgrade](../.orchestrate/aaa3-execution-20260907/migration-upgrade-node22-local-20260907.md) detalha os 5/5 cenários. O [packet browser final](../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md) registra 60/60, incluindo 12/12 de acessibilidade; os packets anteriores permanecem históricos. O [lane browser production-like](../.orchestrate/aaa3-execution-20260907/browser-postgres-synthetic-local-20260907.md) acrescenta 51/51 sem retry com serviços sintéticos, e o [restore smoke](../.orchestrate/aaa3-execution-20260907/postgres-restore-smoke-node22-local-20260907.md) prova somente a recuperação PostgreSQL local. Essas evidências não convertem a projeção relacional shadow em autoridade clínica nem provam cutover, workload-alvo, restore completo ou operação produtiva.

## 5. Crítica independente e rework aplicado

A revisão independente histórica e a rechecagem peer mais recente classificam o candidato como **BLOCKED** para AAA-READY. O parecer completo da rodada anterior está em [`independent-critic-report.md`](../.orchestrate/aaa3-execution-20260907/independent-critic-report.md), a rechecagem após o hardening de replay está em [`independent-critic-report-round2.md`](../.orchestrate/aaa3-execution-20260907/independent-critic-report-round2.md), o packet histórico de métricas antigas está preservado em [`independent-critic-report-round3.md`](../.orchestrate/aaa3-execution-20260907/independent-critic-report-round3.md), a rechecagem round4 permanece arquivada, a rodada independente histórica round6 e a rechecagem peer round7 estão preservadas; o parecer fresco corrente está em [`independent-critic-report-round8.md`](../.orchestrate/aaa3-execution-20260907/independent-critic-report-round8.md) e permanece `BLOCKED`. A suplementação local desta rodada está em [`ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md`](security/ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md); os pareceres apontam principalmente ausência de autoridade de release, cutover/autoridade relacional, operações distribuídas, decisões clínicas e aceite manual. O gap de Node 22 foi fechado nesta continuação com `npm ci`, `npm run validate` e `npm run build` limpos.

Achados de código foram corrigidos e retestados nesta rodada:

- `getReport` filtra anexos para `CLEAN` + `FINALIZED`, impedindo metadados de anexos pendentes/quarentenados em relatório liberado;
- o Patient Workspace possui agora uma fronteira injetável de leitura auxiliar; falhas nessa fronteira marcam `DEGRADED`, preservam requests autorizadas e deixam amostras/resultados/anexos indisponíveis em vez de inventar zeros;
- após a crítica, a tipografia secundária mobile do Patient Workspace foi ampliada, foi reservado espaço inferior para a navegação fixa, o contexto foi reorganizado em duas colunas entre 361–600px e a geometria foi protegida por asserção E2E; o ajuste passou no cenário responsivo 3/3 e na acessibilidade 12/12 com `color-contrast`, incluindo administração/gestão. Também foi corrigida a especificidade do breadcrumb, que havia reduzido o contraste da marca a 1,51:1; o rerun confirmou as três larguras, mas ainda aguarda homologação manual.
- leituras de paciente, atendimento, internação, solicitação e item normalizam identificadores inexistentes para a mesma negativa 404 escopada de recursos fora do escopo; o comportamento possui cobertura unitária/HTTP.
- o `ActionButton` compartilhado agora expõe estados transacionais explícitos (`idle`, `pending`, `confirmed`, `failed`, `unknown` e `denied`), bloqueia ativação duplicada durante `pending`/`denied` e cobre workflow, cadastro de paciente, login, logout, confirmação de notificações e formulários administrativos; a confirmação de notificação permanece pendente até a leitura de reconciliação, com 21 regressões focadas;
- o `ResultView` usa `pendingAction` por operação para que liberação, revisão, upload e edição/invalidação anunciem `aria-busy` somente no controle ativo; os testes cobrem 19 casos do componente e bloqueio de duplicação.
- as leituras assíncronas de fila, indicadores, gestão, administração, pacientes, workspace, solicitação e resultado invalidam respostas obsoletas; RequestDetail e PatientList têm regressões explícitas para respostas fora de ordem e todas as superfícies alteradas expõem estado `pending` no `ActionButton` compartilhado.
- o fluxo `WorkflowAction` associa cada gatilho ao formulário por `aria-controls`, anuncia somente a ação selecionada como expandida, usa `useId` por instância e move o foco para o primeiro campo ao abrir; os testes cobrem alternância e foco sem declarar certificação manual.
- foram adicionados testes mockados de comportamento para serviços compartilhados, SQL de projeção, `PostgresStore`, adapter S3, realtime e leitura relacional; nenhuma dessas evidências acessa a instância PostgreSQL persistente.

Os scores independentes (escopo/verdade 58, autorização 72, contratos/runtime 76, migração 30, workflow clínico 42, operações 32, UX/a11y 68, verificação 64, arquitetura 69, rastreabilidade 52 e autoridade de release 0) são uma crítica adversarial, não uma média substituta. Eles reforçam o bloqueio externo; não anulam os testes locais verdes.

## 6. Notas por dimensão

| Item analisado | Nota /100 | Avaliação resumida |
| --- | ---: | --- |
| Documentação e governança | 86 | Corpus amplo, quality bar, manifesto e planos rastreáveis; números históricos ainda precisam de reconciliação editorial completa. |
| Discovery e PRD | 90 | Problema, personas, jornadas, riscos, requisitos e AC bem descritos; faltam entrevistas, volume real e contrato HIS. |
| Especificação de domínio | 89 | Estados, permissões, erros, busca e realtime detalhados; políticas clínicas ainda abertas. |
| Arquitetura e modularidade | 86 | Monólito modular, packages reais e fitness checks; autoridade relacional e decomposição futura ainda abertas. |
| API e contratos | 94 | OpenAPI, schemas, headers, idempotência, concorrência, drift e operações manifestadas validados. |
| Cadastro, solicitações e filas | 91 | Fluxo principal, escopo, paginação, cards responsivos e ciclo browser verificados. |
| Laboratório estruturado | 88 | Analitos, editor, workflows, versionamento e ciclo clínico local; faixas e criticidade aguardam aprovação clínica. |
| Radiologia e Ultrassom | 86 | Workflows e fluxo browser local cobertos; falta validação clínica, integração real e homologação de laudos. |
| Resultados e anexos | 92 | Versionamento, release, revisão, emenda, void, escopo e anexos protegidos; storage/AV/restore reais pendentes. |
| Segurança, RBAC e privacidade | 90 | Sessão, CSRF, IDOR, escopo, auditoria, reautenticação e hardening negativo verificados; IdP, TLS, LGPD e retenção abertos. |
| Notificações e realtime | 86 | SSE, replay, fallback, outbox, `LISTEN/NOTIFY` sem payload clínico, reconnect nativo, snapshot independente do adapter e browser 60/60 existem; escalonamento crítico, carga e delivery distribuído no ambiente-alvo não homologados. |
| Persistência e integridade | 74 | Migrations, lineage, backfill shadow e a suíte PostgreSQL descartável 39/39, incluindo upgrade 001→010 e retomada SAA-022, estão comprovados; JSONB ainda é a autoridade clínica e cutover/restore-alvo continuam pendentes. |
| Observabilidade e recuperação | 76 | Health, métricas bounded, logger redigido, correlação, SBOM, recovery manifest e runbooks existem; traces, alertas roteados, restore completo, RPO/RTO e exercícios reais não foram provados. |
| Performance e escalabilidade | 75 | Workload determinístico passa; falta carga aprovada, soak, multi-instância no ambiente alvo e failover. |
| UX, responsividade e acessibilidade | 90 | 20 capturas atuais, geometria responsive E2E 3/3 e 12/12 automatizados incluindo contraste; revisão manual visual, touch e leitor de tela ainda pendente. |
| Testes e qualidade automatizada | 95 | 725 testes, cobertura agregada acima do threshold, build, lint, security, recovery, performance, sentinel de mutações 7/7 e matriz browser 60/60 verdes; Node 22 limpo foi validado. O PostgreSQL 39/39 é packet anterior condicional, e o relatório ainda lista 35 arquivos abaixo de limiar por arquivo. |
| Rastreabilidade e gestão de mudança | 84 | Validador 43/43, quality bar e manifesto atuais; decisões D-01 a D-06, CI remoto e aceite continuam abertos. |
| Prontidão produtiva e clínica | 45 | Sem identidade hospitalar, políticas aprovadas, serviços reais, restore completo, piloto e aceite humano. |

## 7. Bloqueios principais

1. PostgreSQL relacional ainda é shadow; JSONB permanece fonte de verdade.
2. Identidade institucional, ownership, transferência, alta, retenção, criticidade, fallback e SLA dependem de decisões humanas.
3. Não há comprovação de restore completo de banco, anexos, configuração e chaves dentro de RPO/RTO aprovado.
4. Não houve validação com carga hospitalar representativa, failover ou CI remoto.
5. O aceite manual de UX, acessibilidade, clínico e hospitalar ainda não ocorreu.
6. A documentação de histórico ainda contém números anteriores, explicitamente marcados como históricos; os documentos correntes foram reconciliados com 725 testes e cobertura 92,72/85,82/94,31% na execução full corrente. A repetição PostgreSQL depende de um cluster descartável não disponível neste host.
7. A crítica independente mantém a densidade textual e o golden visual como pendentes de revisão manual; a sobreposição mobile foi corrigida e revalidada, mas Axe/E2E não substituem leitor de tela, touch e zoom reais.

## 8. Recomendação

Executar o programa State of Art / Triplo AAA documentado em:

- [Plano executivo](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md)
- [Roadmap](build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md)
- [Backlog](build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md)

O próximo passo seguro é fechar o Gate S0: nomear responsáveis, congelar a baseline, corrigir os bloqueios de autorização/build/realtime e registrar as decisões humanas antes de ampliar o cutover relacional ou iniciar qualquer piloto.
