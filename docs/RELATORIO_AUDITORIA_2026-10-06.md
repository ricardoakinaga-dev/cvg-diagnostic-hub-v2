# Auditoria da experiência Plane — 06/10/2026

Auditoria da branch `feat/plane-experience`, partindo de `0ca54ed`, abrangendo a
migração de interface descrita na D-029 e os caminhos clínicos conectados a ela.

## Escopo e critérios

Revisão do diff e dos componentes novos, com dois revisores em paralelo.
Critérios fixados antes das correções: C1 autorização/transições/dados clínicos;
C2 coerência de carga, versões e realtime; C3 destinos e credenciais do gerador
de demonstração; C4 teclado/foco/semântica; C5 responsividade/preferências;
C6 navegação, filtros e layouts. As correções preservam os comandos e regras
do backend. Nenhum merge ou deploy faz parte desta entrega.

As verificações finais usam Node 22.23.2, Next 16.3.8, PostgreSQL 16 descartável
e Chrome local. Os servidores de navegador usam memória e portas próprias.
O banco persistente do hospital e o Plane de referência não recebem dados
destes testes. Credenciais locais não são incluídas neste relatório.

## Achados e correções

| ID | Prioridade | Achado | Tratamento e evidência |
| --- | --- | --- | --- |
| PL-01 | Alta | `source-map-js` 1.2.1 vulnerável, fazendo o audit falhar | Lockfile atualizado para 1.2.2 dentro das faixas existentes; `npm audit` zerado. [Advisory GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Não foi demonstrada exploração na aplicação. |
| PL-02 | Alta | Gerador validava o destino inicial, mas `fetch` seguia redirecionamento que poderia encaminhar a senha | `redirect: "error"`; teste HTTP 307 comprova que o segundo destino não recebe requisição. |
| PL-03 | Média | Falha de carga no Início era apresentada como ausência de exames/atenção | Estado de erro com retry, sem os resumos vazios; reprodução unitária falhou antes e passou após a correção, com regressão no navegador. |
| PL-04 | Média | Falha de atualização preservava exames antigos sem aviso | `StaleNotice`, retry e preservação explícita da lista; teste de falha e recuperação. |
| PL-05 | Média | Preferências inválidas selecionavam layout/agrupamento inconsistentes | Allowlist dos campos e propriedades, booleano validado e normalização do quadro; teste com preferências malformadas. |
| PL-06 | Média | Resultados pendentes de revisão desapareciam do filtro de atrasos do veterinário | Regra local alinhada ao backend: apenas estados terminais ficam fora do atraso; teste dos estados de resultado. |
| PL-07 | Média | Projeção de fila antiga substituía versão clínica mais recente | Enriquecimento de versão inferior é descartado; teste versão 4 versus versão 3. |
| PL-08 | Média | Reconciliação atualizava exames mas deixava indicadores do Início antigos | Dashboard também assina `cvg:realtime-resync`; teste do evento. |
| PL-09 | Média | Quadro omitia destinos vazios de transições permitidas | Colunas necessárias derivadas das transições autorizadas dos exames visíveis; testes de recebimento e recoleta. |
| PL-10 | Média | Painel ocupava a tela móvel mas deixava foco escapar para o fundo; mudar a ação recriava o painel e perdia o acionador original | Modal somente abaixo de 960px, reutilizando isolamento e contenção de foco; identidade do painel depende só do exame. Regressões de navegador validam Tab e retorno ao acionador, inclusive após mudar a ação. |
| PL-11 | Média | Sidebar recolhida no desktop escondia destinos dos setores no celular | Overrides móveis restauram os links; navegação de query fecha o menu. Regressão no navegador. |
| PL-12 | Média | Calendário escondia exames acima de 3 por dia ou 12 por semana, sem acesso | Botão `+N exames` expande o dia; testes abrem o 13º/14º exame em mês e semana. |
| PL-13 | Média | Headers/células do calendário não tinham linhas ARIA | Linhas explícitas mantêm a grade de sete colunas; testes de topologia e axe no calendário. |
| PL-14 | Média | Escape removia item focado dos menus sem devolver foco | Menus de estado e conta restauram o acionador e navegam por setas/Home/End; teste de teclado. |
| PL-15 | Média | Coluna fixa de 340px cobria outras colunas da planilha em telas menores | Fixação horizontal desativada em viewport móvel; revisão de CSS e testes de ordenação/identidade dos exames. |
| PL-16 | Baixa | Gerador informava 14 pacientes criados mesmo quando pulava todos; falhas de avanço terminavam com sucesso | Contagem de registros novos, resumo de falhas e saída não zero para carga parcial; teste de repetição preservando existentes. O plano completo contém 27 exames. |
| PL-17 | Média, pré-existente | Preparação PostgreSQL podia entregar banco ainda com conexão de bootstrap encerrando, gerando recusa de cutover | Harness consulta `pg_stat_activity` pela conexão administrativa até confirmar zero sessões, com prazo de 5s. Trava de migração preservada; nove testes de outbox passaram. |
| PL-18 | Média | Criar solicitação dependia de terminar a carga de todos os exames, embora a sessão já estivesse autenticada | Perfil publicado após autenticação, antes da carga da fila, com proteção contra resposta de sessão antiga. Teste unitário e navegador mantêm a lista pendente e verificam que o formulário abre; o timeout de 5s não foi ampliado. |
| PL-19 | Média | Rollback de comando antigo podia sobrescrever o estado novo recebido por realtime, mantendo a versão nova com o estado antigo | Atualização otimista e rollback verificam a versão dentro do updater funcional. Regressão reproduziu a falha: comando versão 2 pendente, realtime com resultado versão 3 e rejeição do comando 2. |

Para PL-17, a semântica de encerramento do `pg-pool` foi reproduzida sem banco:
`pool.end()` resolve antes do callback de encerramento do cliente. A execução
inicial deu 95/96 PostgreSQL, recusando corretamente uma sessão extra. O PID
histórico não foi capturado; atribuí-lo especificamente ao bootstrap permanece
uma inferência, embora seja a conexão candidata identificada no harness.

As três primeiras regressões funcionais adicionadas falharam na implementação
anterior (3 falhas/15 sucessos). Os testes foram mantidos durante a correção.
Os limites de cobertura, regras de segurança e retries não foram relaxados.
O piso de navegação com mouse passou de 44px para 28px conforme a densidade
autorizada na D-029 e no design system; os controles de toque continuam com
44px, inclusive em telas grandes com ponteiro coarse. A revisão independente
reconciliou essa mudança de requisito, sem tratá-la como aprovação de produção.

## Validação final

| Verificação | Resultado observado |
| --- | --- |
| Unitários | 1.584/1.584 em 134 arquivos |
| PostgreSQL 16 descartável | 96/96 em 17 arquivos; container removido após a execução |
| Cobertura agregada | 1.680 testes em 151 arquivos; 97,04% lines, 95,76% functions, 90,04% branches |
| Gate de cobertura | PASS; mesmas 22 exceções, nenhuma nova, `uncovered` e `stale` vazios |
| Componentes novos de exames | Todos acima dos limites por arquivo: 90% lines/functions e 85% branches |
| Configuração e gerador | 160/160 testes de configuração e 4/4 do gerador |
| Controles de mutação | 7/7 mutantes detectados |
| Performance sintética | 52/52 testes; gates de bytes do snapshot e orçamento de leitura realtime PASS |
| Typecheck, lint e build de produção | PASS com Node 22; build isolado em `.next-plane-audit-build` |
| Dependências e segredos | `npm audit` com zero vulnerabilidades; `security:scan` PASS |
| Documentação e contratos | Docs PASS (89 arquivos obrigatórios), OpenAPI PASS (73 operações/68 paths), rastreabilidade PASS (43/43), migrations PASS (001–014) |
| Navegador | 99/99 na matriz completa, sem retry; após PL-19, 9/9 casos focados nos três tamanhos de tela, incluindo a nova corrida, reconciliação realtime e liberação em um clique |

A execução inicial do navegador passou 81/81. As seis primeiras regressões,
repetidas em desktop/tablet/celular, elevaram a matriz para 99 casos, todos
aprovados em 11,8 minutos. A regressão de PL-19 acrescenta mais três casos ao
conjunto, que agora contém 102; os três passaram na execução focada posterior.
A matriz inteira de 102 não foi reexecutada após PL-19: sua atualização afeta
somente a verificação de versão da alteração otimista/rollback, coberta pela nova
regressão, pela suíte unitária completa e pelos nove casos focados. Uma execução
intermediária encontrou fixtures sem os metadados exigidos pela API e a
dependência de carregamento da criação (PL-18); os fixtures e o código foram
corrigidos. As execuções aprovadas começaram após estabilizar suas alterações,
com `--retries=0`. Nenhuma falha intermediária é contada como sucesso.

Para reproduzir: `npm run test:coverage` com
`ALLOW_POSTGRES_INTEGRATION_TESTS=true` e `POSTGRES_TEST_ADMIN_URL` apontando para
um PostgreSQL descartável em loopback; `npm run test:e2e -- --retries=0` executa
a matriz completa. O `test:config` também executa os testes do gerador. O CI
inclui a nova regressão de navegador e roda ao enviar esta branch.

## Limitações

Esta auditoria cobre a mudança de interface e suas integrações locais; não
substitui pentest, UAT, carga institucional, revisão jurídica de licença ou
aceite de produção. A afirmação de ausência de código copiado do Plane não foi
comprovada por uma análise de similaridade de todo o histórico; esta revisão
inspecionou o código próprio e suas integrações. O calendário representa prazos
de exames, não uma agenda de recursos/procedimentos.

A carga em memória testa as três dimensões de tela, e a suíte PostgreSQL testa
persistência/HTTP/realtime; a matriz inteira de navegador sobre PostgreSQL não
é reexecutada nesta rodada. Dados acima dos limites da carga paginada continuam
incompletos: os avisos esclarecem que filtros locais só alcançam os exames
carregados. Pentest, UAT, carga e decisões institucionais anteriores permanecem
no [backlog de produção](build/PRODUCTION_BACKLOG.md).
