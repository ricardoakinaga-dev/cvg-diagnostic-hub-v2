# Barra de qualidade e aceite AAA-2 — histórico supersedido

> **Aviso (07/09/2026):** esta barra preserva os critérios do ciclo AAA-2 e
> seus snapshots históricos. Ela não é o quality bar corrente; use o
> [quality bar AAA-3](../../.orchestrate/aaa3-execution-20260907/quality-bar.json)
> e o manifesto correspondente para o candidato atual.

**Versão de planejamento:** AAA-2 · **Data:** 05/09/2026 · **Estado do produto:** NOT READY.

[Plano executivo](AAA_2_EXECUTIVE_PLAN.md) · [Roadmap](AAA_2_ROADMAP.md) · [Backlog](AAA_2_BACKLOG.md) · [Auditoria-base](../RELATORIO_AUDITORIA_2026-09-05.md) · [Verificação G5 local](../../.orchestrate/evidence/aaa2-g5-final-20260905.md).

Verificação consolidada mais recente: [packet G5 local de 05/09/2026](../../.orchestrate/evidence/aaa2-g5-final-20260905.md). O packet registra os gates locais executados e os limites que continuam sem aceite externo.

## 1. Significado e controle da barra

AAA representa aqui qualidade funcional/clínica, qualidade técnica e qualidade operacional demonstradas. É um padrão interno proposto, não selo externo. A versão AAA-2 substitui AAA-1 para este programa e preserva seus 22 IDs para comparação. O conteúdo abaixo define metas; não declara o produto conforme.

Congelar esta versão e suas metas de ensaio na mobilização. Mudanças posteriores exigem motivo, impacto, responsável e nova versão; não reduzir exigência depois de uma falha para aceitar o mesmo artefato. Metas que dependem de operação hospitalar estão explicitamente sujeitas à aprovação D-01–D-06 antes do ensaio de aceite.

**AAA-READY final exige:** AAA-01–AAA-22 PASS; todos os MUST/AC aplicáveis verificados; cada dimensão técnica/documental da auditoria ≥95 pela mesma metodologia; zero achado crítico/alto aberto; candidato reproduzível; parecer independente favorável e aceite formal do hospital. Pontuação não substitui qualquer condição. Não há declaração de perfeição absoluta ou de inexistência de vulnerabilidades desconhecidas.

## 2. Níveis de evidência

| Nível | O que permite afirmar | O que ainda exige |
| --- | --- | --- |
| E0 — inspeção | Capacidade presente no código, contrato ou migration | Execução e comportamento nas fronteiras reais |
| E1 — execução local sintética | Comportamento no recorte unitário/HTTP/browser em memória | Persistência, serviços distribuídos e operação |
| E2 — homologação durável | Banco vivo, build de produção, duas instâncias e dependências exercitadas | Revisão humana, política e condições de uso reais |
| E3 — validação humana e operacional | Políticas assinadas, UX manual, exercícios e aceite dos responsáveis | Piloto e decisão de release do candidato específico |
| E4 — piloto e release | Critérios de piloto satisfeitos e liberação formal do candidato | Monitoramento contínuo; nova mudança exige reavaliação proporcional |

G0 não equivale a E2; G4 não equivale a autorização de produção. `BLOCKED`, `FAIL` e `NOT VERIFIED` não contam como PASS. Artefato de teste negativo que demonstra uma rejeição correta pode passar; falha de precondição de ambiente não passa.

## 3. Critérios rejeitáveis

| ID | Exigência de aceite final | Prova mínima e tarefas principais |
| --- | --- | --- |
| AAA-01 — jornadas | Contexto, solicitação, Lab/falha/recoleta, RX/US, resultado/revisão/emenda/void, crítico, transferência/alta e administração completos | E2 + E3; API e browser servido sem mocks de mutação, usuário/versão/dados reais do ensaio; 020–035, 050, 057 |
| AAA-02 — HTTP | PRD/SPEC/OpenAPI/runtime/UI concordam em schemas, status, erros, paginação, versão e idempotência | Drift, casos positivos/negativos e revisão semântica; 003, 030, 034, 035, 052 |
| AAA-03 — entradas | Payload/header/tamanho/nesting e confiança no proxy têm limites e falha segura | Abuso HTTP em E2, corpo inválido, pressão de recursos e rate limit; 037, 051 |
| AAA-04 — autorização | Ator, ação, fase, paciente, serviço, departamento e delegação verificados no servidor | Matriz allow/deny pública incluindo mutações e listas; revogação em duas instâncias; 001, 002, 004, 022, 036 |
| AAA-05 — confidencialidade | Listas/contagens/busca/timeline/SSE/drafts/versões/anexos não revelam recurso indevido | Negativos por superfície e ausência de conteúdo sensível em telemetria; 001, 038–040, 051 |
| AAA-06 — identidade clínica | Patient/owner/encounter/admission e origem inequívocos; homônimo, transferência e alta seguros | Política D-01, migração e jornadas E2/E3; 014, 021, 022, 057 |
| AAA-07 — lifecycle | Estados, agregado, versões, revisão, cancelamento e transições obedecem política sem perda silenciosa | Tabelas de decisão, invariantes, corrida e replay; D-02; 002, 016, 023–028, 050 |
| AAA-08 — persistência | Schema relacional é fonte clínica autoritativa com constraints e consultas adequadas | SQL/telemetria comprovam runtime ativo, sem snapshot/lock global clínico; 011–016, 020 |
| AAA-09 — migração | Upgrade/backfill/cutover são reconciliados e recuperáveis após novas escritas | Bootstrap e upgrade, falha intermediária, retorno ou roll-forward e compatibilidade; 012–016, 020, 058 |
| AAA-10 — multi-instância | Sessão/escopo/dados/limites coerentes entre instâncias e após restart | E2 com duas instâncias concorrentes, revogação e indisponibilidade; 016, 019, 036, 037, 040 |
| AAA-11 — delivery | Eventos têm consumidor correto, confirmação durável e processamento idempotente | FK/transação, lease/token, crash após envio, retry, dedupe, poison/dead letter; 017–019, 027, 028 |
| AAA-12 — realtime | Tela aberta atualiza com frescor mensurável, replay/resync, fallback e recursos limitados | Dois usuários/instâncias, reconexão, Last-Event-ID, cliente lento, expiração e draft conflituoso; 005, 040, 043 |
| AAA-13 — arquivos | Versão, checksum, MIME, scan, quarentena, acesso privado e recuperação completos | Scanner/storage de homologação, falha segura e restore de conteúdo; 026, 038, 045 |
| AAA-14 — observabilidade | Health/readiness/correlação/alertas permitem detectar e agir em falha real | Injeção de falhas, alerta recebido, diagnóstico pelo runbook e cardinalidade controlada; 041, 046, 055 |
| AAA-15 — desempenho | Leituras, comandos, busca e atualização cumprem workload e metas aprovados | PostgreSQL e duas instâncias; p50/p95/p99, erro, throughput, soak e EXPLAIN; 042, 043 |
| AAA-16 — UX | Contexto e próxima ação claros; teclado/touch/leitor/contraste/zoom e estados degradados funcionam | Automação + avaliação manual + usuários; dispositivos e condições identificados; 047–049, 057 |
| AAA-17 — arquitetura | Fronteiras acíclicas, contratos separados de adaptadores e módulos coesos | Fitness sem exceção conveniente, review e integração; mudanças >800 linhas por módulo exigem decomposição ou justificativa revisada; 003, 006, 015, 051 |
| AAA-18 — cadeia e build | Dependências verificadas, segredos protegidos, instalação/build/CI reproduzíveis | Lockfile, scan/audit atual, Node comum, checkout limpo, proveniência do candidato e zero crítico/alto aberto; 008, 010, 039, 051, 053 |
| AAA-19 — recuperação | Banco, anexos e configuração/chaves necessárias restaurados dentro de RPO/RTO aprovados | Ambiente vazio, verificação de conteúdo pela aplicação, tempos e perda medidos; 044, 045, 055, 058 |
| AAA-20 — rastreabilidade | Todo MUST/AC liga contrato, implementação, teste significativo, comando e evidência atual | Validação automática e revisão semântica; nenhum link nominal usado como prova; 008, 009, 050, 052–054 |
| AAA-21 — governança | Políticas clínicas e operacionais possuem dono, aprovação, versão e vigência | D-01–D-05 assinadas; catálogo, crítico/SLA, identidade, revisão e retenção exercitados; 007, 023–029, 035, 044 |
| AAA-22 — release | CI remoto, revisão independente, manual, treino, ensaio, piloto e decisão formal completos | E4; D-06, packet e assinaturas ligados ao candidato final; 053–060 |

## 4. Metas quantitativas propostas

**DECISION de engenharia:** em G4, cobertura mínima de 90% para statements/lines/functions e 85% branches nos módulos executáveis do produto sob medição. Escopo deve incluir aplicação, domínio, runtime, persistência e UI com lógica; exclusões técnicas precisam de justificativa revisada. Relatórios por camada e lacunas de instrumentação são obrigatórios; não combinar denominadores incompatíveis ou excluir módulo difícil. Até G0, manter os limiares existentes e eliminar falhas da suíte; ampliar escopo é AAA2-050.

Para autorização, transições clínicas, isolamento de versão, idempotência e recovery, exigir **100% dos cenários obrigatórios da matriz de risco**, positivos e negativos, incluindo concorrência. Esse percentual mede cenários declarados e revisados, não garante 100% de comportamentos possíveis. Introduzir sentinelas de regressão que comprovem detecção de vazamento de escopo, cancelamento indevido e overwrite de versão. Não exigir testes que apenas repitam detalhes de implementação.

| Métrica | Proposta inicial para homologação | Congelamento/aceite |
| --- | --- | --- |
| Leituras operacionais | p95 ≤500 ms; p99 ≤1.000 ms | D-05 + workload AAA2-042; medição no servidor e latência percebida separadas |
| Comandos clínicos | p95 ≤800 ms; p99 ≤1.500 ms, excluindo transferência física de arquivo medida à parte | D-05; incluir commits concorrentes e nenhuma perda/duplicação |
| Busca exata / textual | p95 ≤300 / ≤800 ms; p99 ≤600 / ≤1.600 ms | D-05; filtros, skew e volume registrados |
| Realtime saudável | p95 ≤2 s entre commit e atualização visível; p99 ≤5 s | D-05; dois usuários/instâncias; fallback com orçamento de polling explícito |
| Disponibilidade | SLO proposto ≥99,9% por mês na janela de serviço definida | D-05; fonte de medição, exclusões e orçamento de erro aprovados; ensaio não prova um mês de operação |
| Falhas sob carga | ≤0,1% de erros inesperados, zero perda de dado ou ação sem autorização | D-05; erros esperados de negócio classificados separadamente |
| Recuperação | RPO ≤15 min; RTO ≤4 h | Propostas até D-05; medir conjunto banco + anexos + configuração necessária, não só execução do script |
| UX | Solicitação contextual em até quatro ações conforme PRD; nenhum erro crítico nas tarefas do aceite | Definir início/fim, amostra e critérios antes do ensaio com usuários |

Esses valores são metas propostas, não resultados auditados nem limites já aprovados pelo hospital. O workload precisa fixar usuários concorrentes, taxa de comandos, volumes por entidade, tamanho de arquivos, histórico, distribuição por setor, máquinas, rede, duração e perfil de pico. Medir nominal, pico e soak; duração do soak deve cobrir os ciclos operacionais/leases/jobs acordados. Não estabelecer carga artificialmente pequena para alcançar latência. Qualquer alteração negociada fica registrada antes da execução.

## 5. Comandos e evidências

Comandos abaixo existem no repositório auditado; a execução corrente de `npm run test:perf` e do harness `npm run perf:synthetic` está registrada como prova local `CONDITIONAL` no packet AAA2-042/043. Os demais comandos não são promovidos a PASS por esta execução; ensaios ampliados serão implementados nas tarefas correspondentes.

| Verificação | Comando/base existente | Aceite adicional |
| --- | --- | --- |
| Instalação e análise | `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build` | Checkout isolado, Node/lockfile fixados e build de produção |
| Unitário/integração local | `npm run test:coverage` | Cenários novos e escopo de cobertura revisado; nenhuma falha ignorada |
| PostgreSQL | `npm run test:postgres` | Opt-in e conexão descartável isolada; migrations, concorrência, cutover e inspeção SQL |
| Browser | `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | Configurar servidor de produção com PostgreSQL; recoleta/US, duas sessões, reconexão e falhas |
| Documentação e API | `npm run validate:docs`, `npm run validate:openapi` | Revisão semântica de todos os requisitos, não só existência de arquivo |
| Rastreabilidade | `node scripts/validate-traceability.mjs`, `node --test scripts/validate-traceability.test.mjs` | G0 registra pendências; G4 exige vínculos/evidências completos e todos os aceites obrigatórios aprovados |
| Segurança | `npm run security:scan`, `npm audit --json` | Revisão de autorização/ameaças e serviços externos; scanner isolado não prova segurança |
| Performance | `npm run test:perf`; `npm run perf:synthetic`; `npm run perf:smoke` para a fronteira HTTP configurada; `npm run test:postgres` para `EXPLAIN` relacional | O harness sintético, o smoke HTTP PostgreSQL local (0 erros; p95 máximo 45,94 ms na última execução) e o `EXPLAIN` estrutural indexado da leitura relacional são evidência `CONDITIONAL`; AAA2-042/043 ainda exigem workload aprovado, duas instâncias, recursos, soak e aceite externo |
| Recovery | `npm run test:recovery`, `npm run db:backup`, `npm run db:restore:smoke` | O manifesto/checksum/plano dry-run e o restore PostgreSQL descartável local passam em `CONDITIONAL`; scripts não provam recovery completo. AAA2-045 exige conteúdo/anexos/configuração, chaves, RPO/RTO e aplicação restaurada |

O executor deve consultar as instruções locais e contratos da versão instalada antes de alterar código. Os comandos destrutivos de migration/restore ficam restritos a ambiente isolado no ensaio; implantação produtiva exige a decisão final do programa.

**Pacote mínimo por execução:** ID do gate/tarefa/requisito, commit e hash do working tree quando houver alterações, data, Node/dependências, ambiente/dataset, comando exato, resultado/exit code, falhas e retries, logs/traces sanitizados, hash dos artefatos, limitações e revisor. Artefatos ignorados pelo Git precisam de retenção durável em CI/repositório de evidências; link para arquivo local temporário não sustenta aceite final.

Primeiro passe determinístico reprovado abre investigação. Novo passe só vale após identificar causa, corrigir quando necessário e registrar a relação entre execuções. Falha de infraestrutura deve ser demonstrada, nunca inferida para apagar falha de produto. Um teste não executado por ambiente é BLOCKED. Revisões manuais e hospitalares têm autor e escopo reais; não podem ser produzidas por inferência automática.

## 6. Fechamento e manutenção

Em G0, a matriz deve expor honestamente lacunas e vincular as provas existentes. O validador forte pode continuar reprovando vínculos ainda ausentes até a entrega correspondente; G0 não pode fingir completude de G4. Registrar essas pendências e seus IDs, mantendo o validador de completude obrigatório no aceite final. Isso não autoriza relaxar o verificador nem renomear ausência como PASS.

Em G4, todos os critérios AAA-01–AAA-21 precisam estar aprovados. G5 acrescenta piloto, governança de release e revalidação do candidato final. Se o piloto produzir mudança material, invalidar e refazer a evidência afetada, inclusive scorecard/revisão, antes de AAA2-060. O estado final permitido sem piloto/autoridade é CANDIDATO TÉCNICO VERIFICADO, com limites explícitos, nunca AAA-READY produtivo.

Após release, monitorar SLO, incidentes, delivery, qualidade clínica, alterações de política e dependências. A revisão de qualidade acompanha cada mudança e incidentes relevantes. AAA não encerra manutenção.
