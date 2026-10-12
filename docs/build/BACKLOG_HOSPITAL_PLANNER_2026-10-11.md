# Backlog — planner hospitalar veterinário

**Versão:** HPL-2026-10.1 · **Data:** 11/10/2026 · **Estado:** 50 entregas em acompanhamento; reparos locais 032/036/047 validados; G4, imagens e navegador composto aprovados com reuso explícito de inputs de teste; capturas anteriores preservadas; homologação e release abertos.

**Atualização de 12/10:** os resultados completos abaixo pertencem ao snapshot de 11/10. A correção de compatibilidade HIS e a fonte corrente estão no [registro de 12/10](HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.md) e no [novo manifesto](HOSPITAL_PLANNER_SOURCE_MANIFEST_2026-10-12.json). G4, imagens e navegador anteriores não certificam automaticamente esse reparo de produto; CI completa deve ser conferida no GitHub. Aceites literais e gates hospitalares permanecem.

[Roadmap](ROADMAP_HOSPITAL_PLANNER_2026-10-11.md) · [Matriz de avaliação](../avaliacoes/plane-preview-2026-10-11/relatorio.html) · [Dados e evidências](../avaliacoes/plane-preview-2026-10-11/matriz.json) · [Gates de produção](PRODUCTION_BACKLOG.md)

## 1. Base e regras de execução

`FACT` — A matriz de 11/10/2026 contém **137 itens**: 69 Parcial, 43 Ausente, 15 Conforme, 4 Não aplicável e 6 Não verificável. Os 112 itens Parcial/Ausente foram consolidados em **50 entregas**. BLD-HPL-051 é o gate adicional de piloto/aceite; as garantias, exclusões e investigações têm registros próprios. Há exatamente um destino primário para cada item da matriz na seção 8.

`FACT` — A situação de origem descreve código inspecionado no Hub `a94e77f4443f700bbb073108594090d40efa4496`, Plane `preview` `bab49bb978ccb56af1d78dec6c6d54dfe8d03c1c` e HIS v4 `0ebfc5b6627c8ed006075dc5285fd3514443c806`. Avaliação estática e evidência anterior não homologam requisitos novos nem aprovam produção.

`DECISION` — A ordenação abaixo é a proposta documental registrada em D-063. Novos contratos devem atualizar PRD, SPEC, API, matriz de acesso e rastreabilidade antes do BUILD; esta lista não substitui essas fontes normativas.

| Campo | Significado |
| --- | --- |
| READY | Sem dependência interna pendente; pode ser refinado/iniciado. Não significa que já foi executado. |
| PLANNED | Aguardando as entregas indicadas; não é erro nem bloqueio de autorização do usuário. |
| OPCIONAL | Só entra no compromisso após escolha de escopo; ainda conserva dependências técnicas. |
| IN_PROGRESS / DONE | Usar apenas durante execução; DONE exige evidência, aceite e commit candidato. Nenhum item começa como DONE. |
| P0 | Gate de segurança/correção da primeira release que introduz ou afeta o comportamento. |
| P1 | Capacidade necessária ao planner e ao piloto hospitalar completo. |
| P2 / P3 | Expansão/conveniência; não bloqueia o piloto salvo dependência explicitamente escolhida. |
| Responsável | Função proposta, sem nomeação real nem compromisso de prazo. |

`ASSUMPTION` — A equipe consegue refinar e entregar fatias verticais. Não há capacidade de equipe, datas de sprint ou estimativas de duração confirmadas. Fase é sequência de dependência, não mês prometido.

A prioridade de cada entrega é a mais alta das suas fontes; BLD-HPL-010 foi elevada a P0 por ser gate de autorização, e BLD-HPL-051 é P0 de release. A prioridade original de cada fonte continua visível na seção 8. A investigação opcional não herda automaticamente obrigação de implementar recurso comercial.

### Critério comum de conclusão

Cada entrega fecha persistência/migração, API/comandos, UI, autorização do servidor, auditoria, concorrência, erros úteis e acessibilidade conforme seu alcance. Testar cenários permitidos e negados e as invariantes afetadas; incluir PostgreSQL real quando houver concorrência ou migração. Jornadas principais funcionam em desktop, tablet e mobile com contas operacionais normais. Segurança permanece no servidor; detalhes técnicos não viram campos extras no fluxo diário.

Antes de marcar DONE: registrar commit, versão de schema se aplicável, evidências dos testes/jornada, aceite da função responsável, limites restantes e instrução de atualização/recuperação. Não copiar resultados de outra versão. Compartilhar evidência com PROD-* quando o aceite for o mesmo.

<a id="execucao"></a>

## Acompanhamento da execução — 11/10/2026

A instrução posterior do dono selecionou **todas as 50 entregas**, inclusive as dez expansões antes opcionais. “Estado inicial” conserva a situação do planejamento; esta seção registra execução. As entregas permanecem IN_PROGRESS porque o critério de DONE também exige commit candidato e aceite da função responsável. D-064 registra os contratos refinados; o [registro de implementação e validação](HOSPITAL_PLANNER_IMPLEMENTATION_2026-10-11.md) concentra as evidências técnicas atuais, sem somar rodadas focadas sobrepostas.

| Escopo | Estado de execução | Evidência / trabalho restante |
| --- | --- | --- |
| 001–010 | IN_PROGRESS: provas técnicas e gates locais presentes; commit e aceite pendentes | 002 possui CORRECTED_TECHNICAL_PROOF: 36/36 PASS, 100% linhas/funções, 95,58% branches; respostas negadas/atrasadas, reautenticação e alvos cobertos com API simulada. Tipos/lint e revisão independente PASS. Nenhum DONE; resultado integrado selado histórico FAIL por 044, preservado, agora com prova específica corrigida. Gates locais e cobertura composta do navegador comprovados na captura anterior de 1.074 arquivos; a prova de 002 e os FAILs históricos permanecem preservados. |
| 011–013 | IN_PROGRESS: implementação técnica presente; configuração real e aceite pendentes | Setores e diretório dinâmico com ciclo de vida; migrações e concorrência verificadas em PostgreSQL descartável. Nenhum setor ou responsável hospitalar foi inventado. |
| 014–019 | IN_PROGRESS: implementação técnica presente; matriz institucional e aceite pendentes | Nove perfis e 148 permissões. Migrações ampliam somente grupos de sistema iguais ao baseline anterior; grupos reduzidos preservam restrições. Revogação, delegação, último administrador, prévia e escopo são revalidados no servidor. |
| 020–021 | IN_PROGRESS: implementação técnica presente; catálogo/conteúdo clínico e aceite pendentes | Serviços gerais separados do diagnóstico; definições e referências históricas preservadas. Publicação exige aprovação declarada; faixas e templates reais precisam de homologação clínica. |
| 022 | IN_PROGRESS: implementação técnica presente; vínculos reais e aceite pendentes | Contexto existente de paciente/tutor/atendimento, autorizado pelo servidor. Atribuição não concede paciente; busca abre o workspace diagnóstico com o vínculo correto. |
| 023–028 | IN_PROGRESS: implementação técnica presente; aceite de uso pendente | Tipos, tarefas, comandos, dependências, intake, visões e busca implementados. Navegador valida criação sob filtro, link, conversa, favorito, assumir/iniciar/concluir e negativas de VIEWER; foco de busca correlaciona cinco categorias entre API e destino real. |
| 029–036 | IN_PROGRESS: implementação técnica presente; inventário, protocolos e aceite pendentes | Planos, plantões, passagem, reservas, leitos, recorrência, cuidado, censo e capacidade com versões/concorrência e worker durável. Rascunhos não contam como trabalho operacional. Ver [cutover](../operations/HOSPITAL_PLANNER_CUTOVER.md); não houve ocupação, protocolo ou aprovação institucional pré-criados. |
| 037–039, 044–046, 048–049 | IN_PROGRESS: 044 com prova técnica corrigida; commit e aceite pendentes | 044 CORRECTED_TECHNICAL_PROOF: 34/34 testes, nove cenários novos, 100% linhas/96,15% funções/93,33% branches; tipos/lint e revisão independente concluídos. O FAIL selado por três falhas de preferências próprias e os focos anteriores permanecem históricos. Gates locais e cobertura composta de navegador comprovados na captura anterior de 1.074 arquivos, sem DONE ou aceite. Scanner/transporte precisam de ensaio hospitalar. |
| 040–041, 043 | IN_PROGRESS: implementação técnica presente; indicadores e aceite pendentes | Jobs duráveis, exportação histórica com autorização atual, instituição e convite exercitados em API/UI e conexões PostgreSQL independentes. Métricas HPL-OPERATIONAL-1 aguardam aprovação institucional. |
| 042, 050 | IN_PROGRESS: implementação técnica presente; ativação/homologação pendentes | HTTPS/HMAC, rotação, recibos e rollback exercitados com destinos sintéticos. Perfil HIS v4 conferido com a fonte inspecionada; a revisão instalada continua [desconhecida](../operations/HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json). Endpoint, credenciais locais e vínculos reais exigem homologação. LIS/PACS e fornecedor de IA não identificados; capacidades permanecem desligadas. |
| 047 | IN_PROGRESS: implementação técnica presente; aceite de uso pendente | Timeline/tabela usam autoridades existentes, datas, dependências e versões. Contas com acesso somente a tarefas não consultam exames sem grant. |
| 051 | IN_PROGRESS: preparação documentada; gate institucional aberto | [Pacote de piloto](../operations/HOSPITAL_PLANNER_PILOT.md) com 16 jornadas, sete ensaios de acesso e seis HIS. Responsável nominal, conteúdo, infraestrutura alvo, resultados de UAT e aceite operacional ainda não existem como evidência desta candidata. |

A fotografia histórica anterior à auditoria individual contém **246 operações em 207 caminhos**, **5.080 testes em 325 arquivos** e 156 cenários de navegador, além dos focos posteriores documentados. O passe de cobertura, build, tipos e lint pertence à candidata identificada no [registro permanente histórico](HOSPITAL_PLANNER_VALIDATION_HISTORY_2026-10-11.json); não certifica alterações posteriores nem todos os critérios de cada entrega.

A [auditoria permanente](HOSPITAL_PLANNER_ACCEPTANCE_AUDIT_2026-10-11.json) preserva as capturas iniciais e as reavaliações literais finais 001–022, 023–036 e 037–050, com digests e limites. A última classificação específica contém **49 PROVEN e 042 PARTIAL**, esta pela homologação externa do HIS adotado. Depois da captura, o achado de retenção de conteúdo após 401/403/404 em **002** foi corrigido: overlay **CORRECTED_TECHNICAL_PROOF**, com 36/36 testes PASS, 100% linhas/funções, 95,58% branches e 96,98% statements; revisão independente sem pendências. RED/GREEN de reautenticação e alvos, logs/digests e limites constam no JSON. São provas específicas de componente, sem certificação global; nenhuma entrega passou a DONE.

O overlay de **042** acrescenta prova local de referência: `sourceContractComparison` no [registro de proveniência HIS](../operations/HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json) conserva os hashes dos sete arquivos contratuais exatos, idênticos entre o commit que corresponde ao texto da tag `272581dc60b7` e o HEAD inspecionado. Artefato SHA-256 `fef4c12f6395df0b2789aa9387fb609c628299c77e1ff7897d26f923abd46e43`. A captura original, **49 PROVEN/042 PARTIAL**, `sourceHeadMatch:UNKNOWN`, `deploymentVerified:false` e gate 051 aberto são preservados. Tag mutável não prova fonte da imagem; endpoint, credencial/mappings e homologação reais continuam pendentes, com LIS/PACS/IA OFF.

O contrato atual tem **248 operações em 209 caminhos**. A tentativa anterior dos gates globais foi **INTERRUPTED (130), às 20:39 UTC**: G4 sem totais finais e navegador com 17 passes parciais antes da interrupção, sem PASS/FAIL final de produto. A rodada selada posterior terminou **FAIL/não certificável** para o escopo de **1.071 arquivos**, fingerprint `c8db8eec35b722a9d460fff31b7c4b8771c3b86359b2970420932881b02fa236`: canônico **exit 1, 147 PASS/42 FAIL de 189**, mais **Home 3 PASS separado**, artefato `test-results/canonical-20261011T204529Z-3580220`. Naquele escopo, **044 REOPENED_REPRODUCED_BUG** por 3 falhas de preferências próprias/controles desabilitados anteriores ao crash; a correção posterior possui prova técnica específica, sem reescrever o FAIL. G4 **5.099 + 141 = 5.240 PASS** e build/tipos/lint/segredos/privacidade 74 arquivos PASS pertencem ao escopo selado; não certificam o navegador nem correções posteriores.

O kernel confirmou OOM somente no cgroup descartável 8 GB/swap 0 da rodada selada anterior; renderer/servidor mortos e 38 falhas em cascata não representam 38 defeitos independentes ou falta de memória da produção. A correção posterior de 044 permanece CORRECTED_TECHNICAL_PROOF, com 34/34 regressões, tipos/lint e revisão independente, sem reescrever o FAIL anterior.

A candidata histórica anterior às adições operacionais tem **1.074 arquivos**, fingerprint SHA-256 `5bb9e94a6ede3d3d715f55b355c2c9789a2e7f286272fcd1fee37cd1e212ce82`. G4 local passou com **5.108 unitários + 141 PostgreSQL = 5.249 testes**, em **356 arquivos de teste**, 464 fontes instrumentadas, **98,41% linhas/95,93% statements/97,17% funções/92,48% branches**, com as mesmas 20 exceções existentes. Build, tipos do projeto completo, lint e segredos passaram; privacidade do bundle: **74 arquivos/zero achados**. Configuração: **238 PASS/3 skip**. A diferença de CI tem quatro regressões PASS e preserva `browser (22.x)` obrigatório, 19 specs/três projetos e Home separado; **GitHub Actions não foi executado**. Os logs/digests e limites de reuso constam no [overlay permanente](HOSPITAL_PLANNER_ACCEPTANCE_AUDIT_2026-10-11.json). Os checks finais documentais e do gate de cobertura persistida são registrados pela raiz no [registro de validação](HOSPITAL_PLANNER_VALIDATION_2026-10-11.json).

O canônico inicial de 1.073 arquivos terminou **FAIL, exit 1, 187 PASS/2 FAIL de 189**, mais **Home 3 PASS separado**, em `test-results/canonical-20261011T211723Z-3709542`. As duas falhas tablet foram GETs de observação por `APIRequestContext`, com `read ECONNRESET` antes dos asserts de domínio. Reuso/keepalive é hipótese, não causa demonstrada. A correção alterou somente o transporte de quatro GETs em dois specs para fetch único same-origin no navegador, sem retries; assertions, POSTs, CSRF, fluxos e produto ficaram iguais. Os suplementos reais na candidata histórica de 1.074 arquivos passaram: **tablet 63/63 + Home 1**, mais **três jornadas afetadas Chromium e três mobile + Home 1 de cada**, todos com exit 0. Só os **60 cenários inalterados de cada um desses dois viewports** foram reutilizados. A cobertura efetiva é **189/189 — PASS_AFTER_TEST_TRANSPORT_CORRECTION**, formada por **69 reexecutados + 120 inalterados reutilizados**; **não é uma execução única final com 189 PASS**. O FAIL inicial, o FAIL selado 147/42, as capturas/digests e os limites das provas anteriores permanecem históricos. Artefatos dos suplementos: `test-results/canonical-20261011T214110Z-3825883` e `test-results/canonical-20261011T214849Z-3855638`. Não há DONE, aceite institucional, release aplicado ou fechamento de 051; **042 continua PARTIAL**.

As migrações 025/026 ampliam o catálogo a 146/148 permissões preservando grupos reduzidos; a 027 acrescenta recibos HIS sem ampliar a matriz. O banco de testes é descartável e separado da instalação local. A árvore ainda não foi commitada, e nenhuma migração ou implantação foi aplicada ao serviço hospitalar nesta etapa. Homologação, release e gate 051 permanecem abertos.

## Revisão funcional posterior — 032, 036 e 047

A [nova evidência permanente](HOSPITAL_PLANNER_FUNCTIONAL_FOLLOWUP_2026-10-11.json) registra falhas reproduzidas e reparos locais: links da agenda chegam à solicitação e ao exame; execução aberta permanece visível quando cruza o período; recurso sem término real não aparece livre; filtros por plano/fase preservam os exames autorizados no cronograma. Início ausente ou inconsistente não cria horário fictício; cancelamento usa seu registro real. Reservas planejadas, estados clínicos, SLA e permissões mantêm suas autoridades.

A candidata corrente tem **1.082 arquivos**, fingerprint SHA-256 `bf1e6600023933d6e5ef313cc53596fce8332535d7ed202ab4284003ac94445c`. O produto corrigido passou no G4 completo: **5.283 testes** em 360 arquivos (5.142 unitários + 141 PostgreSQL), cobertura de linhas **98,41%**, sem novas exceções. Agenda/capacidade e cronograma passaram também nos 110 e 25 testes direcionados. O navegador reúne **195 cenários aprovados por composição: 192 + 2 + 1**, com falhas originais preservadas; não houve uma única execução completa de 195 aprovada. Tipos e lint passaram novamente na candidata atual. As imagens app/ops foram construídas, varridas, tiveram SBOM e **18 verificações de execução** aprovadas; o perfil HTTP curto passou com duas jornadas e 57 requisições. G4, imagens e perfil mediram a fonte `673bc9…`; a única alteração posterior foi o seletor/transporte de um teste E2E, com reuso explícito dos demais 1.081 arquivos e dos dois assets públicos. Relatórios e gate hospitalar mantêm seus limites.

A observação adicional do [HIS instalado](../operations/HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json) às 22:59 UTC conserva a captura inicial: identidades de SPA/API mudaram e worker permaneceu igual, sem labels de revisão/origem. Não comprova o commit das imagens nem uma troca real com o Hub. **042 PARTIAL, 051 OPEN, DONE zero e release não aplicada** permanecem.

## Captura operacional anterior — 1.079 arquivos

A candidata corrigida tem **1.079 arquivos**, fingerprint SHA-256 `2afa82c5b706c9fc6469dfa4f4c2455ea43796da0c3f1aed08ce149c06f134d4`. A nova execução G4 completa passou: **5.119 unitários + 141 PostgreSQL = 5.260 testes**, em **357 arquivos**, com **464 fontes instrumentadas** e linhas: 98,41% / statements: 95,93% / funções: 97,17% / branches: 92,49%. As mesmas 20 exceções foram mantidas, sem novas exceções ou redução de mínimos. Tipos do projeto completo e lint passaram; configuração: **242 PASS/4 skips opcionais**, com entradas desse gate intactas após as duas correções de teste. A rodada anterior `6e2e33173903ea7b71a140aefd90c3a814b2bb819d4617a61dbb0db6bcedb4d6` permanece **FAIL: 5.113 PASS/2 FAIL unitários, PostgreSQL não executado**. As correções atingiram somente dois testes: inventário de segredos do exporter e espera independente do cadastro de setores, com RED determinístico e GREEN, sem alterar produto, loader ou permissões, relaxar as negativas de acesso ou aumentar timeouts.

O [registro operacional permanente](HOSPITAL_PLANNER_OPERATIONAL_EVIDENCE_2026-10-11.json) identifica build, scans/SBOM e **18 checks de execução isolada das imagens finais**, incluindo usuário normal, recusa administrativa, migrações 001–027 e worker real. `SOURCE_REVISION=unknown` identifica honestamente a árvore sem commit. O critério Trivy foi HIGH/CRITICAL corrigível e segredos detectados; ambas as imagens passaram. O bundle cliente final tem **74 arquivos/zero achados**. Banco, rede, containers e builder próprios foram removidos; os serviços hospitalares não foram modificados.

O monitor PostgreSQL tem **12 PASS/2 skips opcionais** na prova nativa: mTLS, três coletores numéricos, papel sem leitura clínica e falha fechada diante de privilégios excedentes. O [perfil HPL](../operations/HOSPITAL_PLANNER_PERFORMANCE.md) passou com **duas jornadas, 57 requisições, 11 negativas e oito invariantes**; p95 local de leitura **84,42 ms** e escrita **33,79 ms**. É regressão sintética curta; não comprova capacidade, soak ou SLO hospitalar. Os contadores `auditEvents/outbox=0` são arrays projetados, não contagens SQL ou ausência de auditoria. Instalação real, rota de alertas e carga no alvo continuam pendentes.

Navegador e performance mantêm as capturas originais com reuso explícito por entradas relevantes byte a byte iguais. Não houve nova execução de navegador após essas adições: **189 jornadas efetivas compostas**, sem alegar um único run final de 189 PASS. A mudança de `package.json` limita-se a scripts de performance, com dependências/lock intactos. O [registro atual](HOSPITAL_PLANNER_VALIDATION_2026-10-11.json) e o [histórico](HOSPITAL_PLANNER_VALIDATION_HISTORY_2026-10-11.json) conservam as capturas, falhas e limites. **042 PARTIAL, 051 OPEN, DONE zero e release não aplicada** permanecem.

## 2. Fila consolidada

| ID | Fase | Pri | Estado inicial | Entrega | Dependências internas |
| --- | --- | --- | --- | --- | --- |
| [BLD-HPL-001](#bld-hpl-001) | F1 | P0 | READY | Navegação administrativa com destinos corretos | — |
| [BLD-HPL-002](#bld-hpl-002) | F1 | P0 | READY | Coerência de menus, botões, API e realtime | — |
| [BLD-HPL-003](#bld-hpl-003) | F1 | P0 | READY | Confirmação e localização do exame recém-criado | — |
| [BLD-HPL-004](#bld-hpl-004) | F1 | P0 | READY | Mesmo escopo no resumo e na fila | — |
| [BLD-HPL-005](#bld-hpl-005) | F1 | P1 | READY | Paginação e continuidade do histórico | — |
| [BLD-HPL-006](#bld-hpl-006) | F1 | P1 | READY | Preferências por usuário e visão | — |
| [BLD-HPL-007](#bld-hpl-007) | F1 | P1 | READY | Fuso hospitalar na entrada e na apresentação | — |
| [BLD-HPL-008](#bld-hpl-008) | F1 | P1 | READY | Abrir o conteúdo de versões anteriores | — |
| [BLD-HPL-009](#bld-hpl-009) | F1 | P0 | READY | Política explícita de acesso aos exames atuais e futuros | — |
| [BLD-HPL-010](#bld-hpl-010) | F1 | P0 | READY | Catálogo de comandos e regressão da matriz de acesso | — |
| [BLD-HPL-011](#bld-hpl-011) | F2 | P1 | READY | Contrato de ciclo de vida dos cadastros | — |
| [BLD-HPL-012](#bld-hpl-012) | F2 | P1 | PLANNED | Cadastro real de setores | [BLD-HPL-011](#bld-hpl-011) |
| [BLD-HPL-013](#bld-hpl-013) | F2 | P1 | PLANNED | Setores, equipes e responsáveis em todas as telas | [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-012](#bld-hpl-012) |
| [BLD-HPL-014](#bld-hpl-014) | F2 | P1 | PLANNED | Usuário com identidade e setor corretos desde a criação | [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-012](#bld-hpl-012) |
| [BLD-HPL-015](#bld-hpl-015) | F2 | P1 | PLANNED | Grupos de acesso e editor de matriz | [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-016](#bld-hpl-016) |
| [BLD-HPL-016](#bld-hpl-016) | F2 | P0 | PLANNED | Delegação e revogação com fronteiras claras | [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011) |
| [BLD-HPL-017](#bld-hpl-017) | F2 | P1 | PLANNED | Prévia e explicação do acesso efetivo | [BLD-HPL-015](#bld-hpl-015), [BLD-HPL-016](#bld-hpl-016) |
| [BLD-HPL-018](#bld-hpl-018) | F2 | P1 | PLANNED | Vínculo ao grupo base e migração dos nove perfis | [BLD-HPL-014](#bld-hpl-014), [BLD-HPL-015](#bld-hpl-015), [BLD-HPL-016](#bld-hpl-016), [BLD-HPL-017](#bld-hpl-017) |
| [BLD-HPL-019](#bld-hpl-019) | F2 | P1 | PLANNED | Concessão e retirada do escopo assistencial | [BLD-HPL-016](#bld-hpl-016), [BLD-HPL-018](#bld-hpl-018) |
| [BLD-HPL-020](#bld-hpl-020) | F2 | P1 | PLANNED | Serviços hospitalares ligados ao setor | [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-012](#bld-hpl-012) |
| [BLD-HPL-021](#bld-hpl-021) | F2 | P0 | PLANNED | Exames e templates publicados com histórico preservado | [BLD-HPL-008](#bld-hpl-008), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-020](#bld-hpl-020) |
| [BLD-HPL-022](#bld-hpl-022) | F2 | P1 | PLANNED | Paciente, tutor e atendimento no contexto do planner | [BLD-HPL-019](#bld-hpl-019) |
| [BLD-HPL-023](#bld-hpl-023) | F3 | P1 | PLANNED | HospitalTask com tipos, estados e comandos próprios | [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-019](#bld-hpl-019) |
| [BLD-HPL-024](#bld-hpl-024) | F3 | P1 | PLANNED | Responsáveis, prioridade e datas de planejamento | [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-023](#bld-hpl-023) |
| [BLD-HPL-025](#bld-hpl-025) | F3 | P1 | PLANNED | Subtarefas e dependências rastreáveis | [BLD-HPL-024](#bld-hpl-024) |
| [BLD-HPL-026](#bld-hpl-026) | F3 | P1 | PLANNED | Visões salvas e filtros consistentes | [BLD-HPL-005](#bld-hpl-005), [BLD-HPL-006](#bld-hpl-006), [BLD-HPL-024](#bld-hpl-024) |
| [BLD-HPL-027](#bld-hpl-027) | F3 | P1 | PLANNED | Intake e triagem operacional | [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023), [BLD-HPL-024](#bld-hpl-024) |
| [BLD-HPL-028](#bld-hpl-028) | F3 | P1 | PLANNED | Busca autorizada dos objetos do planner | [BLD-HPL-005](#bld-hpl-005), [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023), [BLD-HPL-026](#bld-hpl-026) |
| [BLD-HPL-029](#bld-hpl-029) | F4 | P1 | PLANNED | Plano de trabalho do atendimento | [BLD-HPL-022](#bld-hpl-022), [BLD-HPL-025](#bld-hpl-025), [BLD-HPL-026](#bld-hpl-026) |
| [BLD-HPL-030](#bld-hpl-030) | F4 | P1 | PLANNED | Escala, plantões e cobertura real | [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029) |
| [BLD-HPL-031](#bld-hpl-031) | F4 | P1 | PLANNED | Passagem de plantão com aceite explícito | [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030) |
| [BLD-HPL-032](#bld-hpl-032) | F4 | P1 | PLANNED | Agenda horária por recurso, profissional e sala | [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-020](#bld-hpl-020), [BLD-HPL-024](#bld-hpl-024) |
| [BLD-HPL-033](#bld-hpl-033) | F4 | P1 | PLANNED | Inventário de leitos, censo e transferência | [BLD-HPL-012](#bld-hpl-012), [BLD-HPL-022](#bld-hpl-022), [BLD-HPL-032](#bld-hpl-032) |
| [BLD-HPL-034](#bld-hpl-034) | F4 | P1 | PLANNED | Rotinas recorrentes e checklists versionados | [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030) |
| [BLD-HPL-035](#bld-hpl-035) | F4 | P1 | PLANNED | Procedimentos e cuidados além do diagnóstico | [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-034](#bld-hpl-034) |
| [BLD-HPL-036](#bld-hpl-036) | F4 | P1 | PLANNED | Capacidade e SLA com semântica explícita | [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-033](#bld-hpl-033) |
| [BLD-HPL-037](#bld-hpl-037) | F5 | P1 | PLANNED | Comentários e anexos em tarefas | [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023) |
| [BLD-HPL-038](#bld-hpl-038) | F5 | P1 | PLANNED | Notificações de trabalho, leitura e confirmação distintas | [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-031](#bld-hpl-031) |
| [BLD-HPL-039](#bld-hpl-039) | F5 | P1 | PLANNED | Documentos operacionais aprovados e versões utilizadas | [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-023](#bld-hpl-023) |
| [BLD-HPL-040](#bld-hpl-040) | F5 | P1 | PLANNED | Indicadores de planejamento e execução | [BLD-HPL-004](#bld-hpl-004), [BLD-HPL-026](#bld-hpl-026), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-036](#bld-hpl-036) |
| [BLD-HPL-041](#bld-hpl-041) | F5 | P2 | OPCIONAL | Relatórios salvos e exportação operacional | [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-040](#bld-hpl-040) |
| [BLD-HPL-042](#bld-hpl-042) | F5 | P2 | OPCIONAL | Integrações HIS/LIS/PACS e contratos externos | [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-021](#bld-hpl-021), [BLD-HPL-023](#bld-hpl-023) |
| [BLD-HPL-043](#bld-hpl-043) | F6 | P2 | OPCIONAL | Configuração institucional, convites e capacidades por setor | [BLD-HPL-012](#bld-hpl-012), [BLD-HPL-018](#bld-hpl-018) |
| [BLD-HPL-044](#bld-hpl-044) | F6 | P2 | OPCIONAL | Perfil, favoritos, recentes e notas pessoais | [BLD-HPL-006](#bld-hpl-006), [BLD-HPL-028](#bld-hpl-028) |
| [BLD-HPL-045](#bld-hpl-045) | F6 | P2 | OPCIONAL | Detalhes avançados e acompanhamento de atividades | [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-037](#bld-hpl-037), [BLD-HPL-038](#bld-hpl-038) |
| [BLD-HPL-046](#bld-hpl-046) | F6 | P2 | OPCIONAL | Operações em lote com resultado por item | [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-023](#bld-hpl-023) |
| [BLD-HPL-047](#bld-hpl-047) | F6 | P2 | OPCIONAL | Gantt e edição em tabela | [BLD-HPL-025](#bld-hpl-025), [BLD-HPL-032](#bld-hpl-032) |
| [BLD-HPL-048](#bld-hpl-048) | F6 | P2 | OPCIONAL | Editor rico e coedição de documentos | [BLD-HPL-039](#bld-hpl-039) |
| [BLD-HPL-049](#bld-hpl-049) | F6 | P2 | OPCIONAL | Arquivo pessoal de notificações | [BLD-HPL-038](#bld-hpl-038) |
| [BLD-HPL-050](#bld-hpl-050) | F6 | P3 | OPCIONAL | Assistência de IA opcional e revisável | [BLD-HPL-039](#bld-hpl-039), [BLD-HPL-045](#bld-hpl-045) |
| [BLD-HPL-051](#bld-hpl-051) | F5 | P0 | PLANNED | Homologação, piloto e gates de release | Núcleo obrigatório F1–F5 e gates PROD-* |

F5 tem duas expansões condicionais (041–042); F6 inteira é opcional. Em 029/030/039, o ciclo de vida e o histórico são necessários, enquanto favoritos podem vir depois. 044/045 agrupam conveniências P2 e P3; notas, reações e IA não se tornam bloqueadores por estarem agrupadas.

## 3. Entregas e critérios de aceite

### F1 — coerência e segurança da base

<a id="bld-hpl-001"></a>

#### BLD-HPL-001 — Navegação administrativa com destinos corretos

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Frontend + segurança.

**Fontes:** [D001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D001). **Depende de:** Nenhuma dependência interna.

**Entrega:** Corrigir os links de Acessos, Catálogos e Auditoria e os gates de navegação.

**Aceite:** Abrir /admin/users, /admin/catalog e /system#audit conforme a ação escolhida; cada destino mostra seu conteúdo e verifica acesso direto. SUPERADMIN navega entre administração e operação; ADMIN conserva sua fronteira técnica.

**Evidência exigida:** Jornada de navegação por perfil, URL direta permitida/negada e verificação em desktop e mobile.

<a id="bld-hpl-002"></a>

#### BLD-HPL-002 — Coerência de menus, botões, API e realtime

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Segurança + frontend + backend.

**Fontes:** [D002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D002), [A019](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A019). **Depende de:** Nenhuma dependência interna.

**Entrega:** Aplicar a política atual de autorização e o estado do recurso às ações disponíveis, preservando checagem no servidor.

**Aceite:** VIEWER não recebe ações de mutação, revisão ou confirmação crítica; chamada direta continua negada. Os nove perfis veem os comandos elegíveis e um recurso fora do escopo não aparece em busca, exportação ou realtime. Estender o mesmo contrato às entidades futuras.

**Evidência exigida:** Casos permitido/negado por comando e contexto; tentativa HTTP direta e mudança de acesso com tela aberta.

<a id="bld-hpl-003"></a>

#### BLD-HPL-003 — Confirmação e localização do exame recém-criado

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Frontend + backend.

**Fontes:** [D003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D003). **Depende de:** Nenhuma dependência interna.

**Entrega:** Usar o identificador devolvido pelo servidor para confirmar a solicitação e oferecer abertura imediata.

**Aceite:** Usuário normal autorizado cria exame e abre o registro pelo retorno da operação. Quando um filtro explícito o oculta, a tela informa o filtro e oferece limpeza; não induz novo cadastro. Repetição idempotente não duplica solicitação.

**Evidência exigida:** Reproduzir criação com filtro ativo, outro autor e sessão de usuário operacional; conferir o registro persistido e o link aberto.

<a id="bld-hpl-004"></a>

#### BLD-HPL-004 — Mesmo escopo no resumo e na fila

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Backend + frontend.

**Fontes:** [D004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D004). **Depende de:** Nenhuma dependência interna.

**Entrega:** Alinhar setores autorizados, filtros, denominadores e links dos indicadores às listagens.

**Aceite:** MANAGER lotado em IT com delegação clínica e SUPERADMIN abrem a mesma população autorizada apresentada no agregado. A lotação principal não substitui a delegação; usuários sem concessão não veem dados clínicos.

**Evidência exigida:** Fixture com setores próprios, delegados e negados; comparar IDs e total entre painel e lista.

<a id="bld-hpl-005"></a>

#### BLD-HPL-005 — Paginação e continuidade do histórico

**Prioridade:** P1 · **Estado inicial:** READY · **Responsável proposto:** Backend + frontend.

**Fontes:** [D005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D005), [P018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P018). **Depende de:** Nenhuma dependência interna.

**Entrega:** Adicionar continuação real nas timelines de paciente, arquivo e inbox e revisar as listagens afetadas.

**Aceite:** Buscar e abrir registro além dos limites atuais de 20/50; cursor é aplicado pela API, sem repetição ou perda entre páginas de uma consulta estável. Busca e total conservam o escopo. A timeline da solicitação não é tratada como se tivesse o corte de 20 do paciente.

**Evidência exigida:** Histórico maior que uma página, itens arquivados e notificações; navegar começo/fim e tentar cursor em escopo negado.

<a id="bld-hpl-006"></a>

#### BLD-HPL-006 — Preferências por usuário e visão

**Prioridade:** P1 · **Estado inicial:** READY · **Responsável proposto:** Frontend + backend.

**Fontes:** [D006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D006), [P051](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P051). **Depende de:** Nenhuma dependência interna.

**Entrega:** Isolar filtros e apresentação por identidade e superfície, com migração segura da chave antiga.

**Aceite:** Trocar usuário no mesmo navegador não herda filtros do anterior; trocar rota conserva escolhas compatíveis. Preferência antiga sem dono inequívoco é descartada ou confirmada, nunca atribuída silenciosamente. Logout limpa estado sensível.

**Evidência exigida:** Alternar duas contas e duas rotas; reload, logout/login e migração da preferência antiga.

<a id="bld-hpl-007"></a>

#### BLD-HPL-007 — Fuso hospitalar na entrada e na apresentação

**Prioridade:** P1 · **Estado inicial:** READY · **Responsável proposto:** Backend + frontend + operação hospitalar.

**Fontes:** [D007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D007). **Depende de:** Nenhuma dependência interna.

**Entrega:** Persistir instantes em UTC e converter entrada e apresentação usando o fuso configurado do hospital.

**Aceite:** Dois dispositivos em fusos diferentes veem o mesmo horário hospitalar. Horários inválidos ou ambíguos são tratados explicitamente; prazo, horário planejado e execução real mantêm semânticas distintas.

**Evidência exigida:** Casos de conversão, virada de dia, duração e mudanças de fuso aplicáveis; navegador com timezone diferente.

<a id="bld-hpl-008"></a>

#### BLD-HPL-008 — Abrir o conteúdo de versões anteriores

**Prioridade:** P1 · **Estado inicial:** READY · **Responsável proposto:** Backend + frontend + diagnóstico.

**Fontes:** [D008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D008), [P022](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P022). **Depende de:** Nenhuma dependência interna.

**Entrega:** Navegar o conteúdo das versões disponíveis de resultado, identificando revisão e versão vigente.

**Aceite:** Selecionar uma versão mostra seu próprio conteúdo autorizado e autoria, sem alterar a vigente. Versão indisponível é informada. Esta entrega não afirma que o catálogo/template histórico já está congelado: essa lacuna pertence à BLD-HPL-021.

**Evidência exigida:** Resultado liberado, emendado e anulado; comparar versões, negar acesso e assegurar ausência de escrita ao consultar.

<a id="bld-hpl-009"></a>

#### BLD-HPL-009 — Política explícita de acesso aos exames atuais e futuros

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Segurança + backend + frontend.

**Fontes:** [A007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A007), [A014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A014). **Depende de:** Nenhuma dependência interna.

**Entrega:** Substituir a inferência de acesso por modos explícitos: nenhum, seleção, todos atuais e política separada para futuros.

**Aceite:** Nenhum permanece nenhum inclusive no catálogo vazio e no primeiro serviço. Seleção completa não se torna autorização futura. Criar, importar, reativar ou transferir serviço aplica somente a política confirmada e identifica usuários afetados. Migração conserva concessões materializadas; intenção desconhecida não amplia acesso.

**Evidência exigida:** Matriz criação/edição/importação/reativação/transferência, catálogo vazio e seleção completa; comparação de concessões antes/depois e auditoria dos afetados.

<a id="bld-hpl-010"></a>

#### BLD-HPL-010 — Catálogo de comandos e regressão da matriz de acesso

**Prioridade:** P0 · **Estado inicial:** READY · **Responsável proposto:** Segurança + backend + QA.

**Fontes:** [A010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A010), [A020](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A020). **Depende de:** Nenhuma dependência interna.

**Entrega:** Documentar permissões por recurso/comando e preparar os casos de concessão e negação que governam novas entregas.

**Aceite:** As 55 permissões atuais e nove perfis têm concessões básicas rastreáveis, com cenários adicionais de paciente, setor, serviço, autoria, sessão e estado. Consultar, criar, alterar, desativar e vincular só aparecem como ações independentes se a API puder autorizá-las independentemente. Ampliar a matriz a cada recurso novo.

**Evidência exigida:** Baseline 55×9, negativos em API/UI e concorrência; conferir limites MANAGER/ADMIN/SUPERADMIN. A tabela de grants não substitui testes de contexto.

### F2 — cadastros e governança de acesso

<a id="bld-hpl-011"></a>

#### BLD-HPL-011 — Contrato de ciclo de vida dos cadastros

**Prioridade:** P1 · **Estado inicial:** READY · **Responsável proposto:** Backend + dados + segurança.

**Fontes:** [A018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A018). **Depende de:** Nenhuma dependência interna.

**Entrega:** Definir identidade estável, versão, idempotência, inativação, referências e eventos auditados para os novos cadastros.

**Aceite:** Alteração concorrente falha de forma explícita; inativação bloqueia novos vínculos e preserva histórico e pendências. Auditoria registra ator, contexto, antes/depois e razão da operação. Respeitar D-024: metadados são automáticos; motivo digitado e reautenticação seguem regras clínicas ou de risco, sem exigir campos extras em toda edição diária.

**Evidência exigida:** Contrato e migration revisados; update concorrente, repetição idempotente e cadastro inativo com registros referenciados; demonstrar recuperação.

<a id="bld-hpl-012"></a>

#### BLD-HPL-012 — Cadastro real de setores

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + gestão hospitalar.

**Fontes:** [A001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A001), [P009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P009). **Depende de:** [BLD-HPL-011](#bld-hpl-011)

**Entrega:** Criar, listar, editar e inativar Department com código estável, nome, tipo e responsável.

**Aceite:** Cadastrar setor sem alteração de código; código único e referências válidas. Renomear não altera identificadores históricos; inativar mostra pendências e impede novos vínculos conforme contrato. Os códigos existentes migram para entidades sem perder usuários ou exames.

**Evidência exigida:** Migração dos códigos existentes, criação/edição/inativação por ator permitido e negado e consulta de histórico.

<a id="bld-hpl-013"></a>

#### BLD-HPL-013 — Setores, equipes e responsáveis em todas as telas

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Frontend + backend + gestão hospitalar.

**Fontes:** [A002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A002), [P011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P011), [P012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P012). **Depende de:** [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-012](#bld-hpl-012)

**Entrega:** Consumir Department nos menus, filtros, filas, catálogo e cadastro; gerir participação e responsáveis elegíveis.

**Aceite:** Novo setor e seu serviço aparecem nas superfícies autorizadas sem hardcode. Responsável padrão e equipe não concedem acesso a paciente por si. Vínculo retirado muda elegibilidade na próxima operação; setores restritos permanecem restritos.

**Evidência exigida:** Criar setor inédito e percorrer menus, usuário, serviço, solicitação e fila; profissional sem vínculo recebe negativa.

<a id="bld-hpl-014"></a>

#### BLD-HPL-014 — Usuário com identidade e setor corretos desde a criação

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Frontend + backend + segurança.

**Fontes:** [A006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A006). **Depende de:** [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-012](#bld-hpl-012)

**Entrega:** Permitir escolha do setor autorizado no cadastro, edição de nome/e-mail e confirmação explícita do acesso inicial.

**Aceite:** ADMIN/SUPERADMIN escolhem setor permitido; MANAGER só administra alvos e setores delegáveis. Conta entra no setor escolhido, sem edição corretiva. Troca de identidade e acesso respeita unicidade, sessão, versão e auditoria; senha temporária continua exibida uma vez.

**Evidência exigida:** Jornada completa por administrador técnico, gestor e superadmin; tentativas de promoção indevida, e-mail duplicado e edição concorrente.

<a id="bld-hpl-015"></a>

#### BLD-HPL-015 — Grupos de acesso e editor de matriz

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Segurança + backend + frontend.

**Fontes:** [A008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A008), [A011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A011). **Depende de:** [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-016](#bld-hpl-016)

**Entrega:** Criar grupos com código, descrição, estado, revisão e matriz de ações efetivamente independentes no servidor.

**Aceite:** Grupo somente de criação cria e recebe negativa para alterar/desativar pela API. CRUD de grupo é auditável e nomes são únicos. Visualizar uma tela não concede todos os comandos. Alteração do editor é validada contra o limite de delegação do ator.

**Evidência exigida:** Criar/editar/inativar grupo; API direta, matriz por ação, conflito de revisão e delegação negada. Não copiar as quatro flags HIS que compartilham write.

<a id="bld-hpl-016"></a>

#### BLD-HPL-016 — Delegação e revogação com fronteiras claras

**Prioridade:** P0 · **Estado inicial:** PLANNED · **Responsável proposto:** Segurança + backend + frontend.

**Fontes:** [A015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A015), [A016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A016). **Depende de:** [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-011](#bld-hpl-011)

**Entrega:** Definir ações, grupos, escopos e alvos delegáveis e o efeito de inativar grupo, equipe, setor, usuário ou vínculo.

**Aceite:** MANAGER não promove a si ou terceiros a administração global; ADMIN não atribui SUPERADMIN. Retirada vale na próxima operação e é reavaliada no stream antes de emitir dados, inclusive com sessão aberta. Exceções/concessões restantes são explicadas. Inativar grupo não equivale automaticamente a inativar conta.

**Evidência exigida:** Casos de autoelevação, alvo privilegiado, permissões combinadas, revogação com sessão/SSE abertos, cache e último administrador.

<a id="bld-hpl-017"></a>

#### BLD-HPL-017 — Prévia e explicação do acesso efetivo

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Segurança + frontend + backend.

**Fontes:** [A012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A012). **Depende de:** [BLD-HPL-015](#bld-hpl-015), [BLD-HPL-016](#bld-hpl-016)

**Entrega:** Mostrar origem da concessão, grupo/perfil, escopos, restrições e diferença prevista antes de salvar.

**Aceite:** Administrador entende por que uma ação é permitida ou negada e quais pessoas/recursos mudarão. Prévia usa a política efetiva do servidor e não expõe pacientes que o próprio administrador não pode acessar. Concessões restantes após inativação ficam visíveis.

**Evidência exigida:** Comparar prévia e decisão após salvar; combinações grupo/perfil/serviço/paciente e erro concorrente.

<a id="bld-hpl-018"></a>

#### BLD-HPL-018 — Vínculo ao grupo base e migração dos nove perfis

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Segurança + dados + backend.

**Fontes:** [A009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A009). **Depende de:** [BLD-HPL-014](#bld-hpl-014), [BLD-HPL-015](#bld-hpl-015), [BLD-HPL-016](#bld-hpl-016), [BLD-HPL-017](#bld-hpl-017)

**Entrega:** Adotar um grupo base por usuário inicialmente, mantendo perfil/elegibilidade clínica como restrições próprias.

**Aceite:** Migração conserva acesso atual sem ampliação involuntária e permite comparar antes/depois por usuário. Troca de grupo é explícita e auditada; grupo não torna pacientes globais, não converte ADMIN técnico em clínico e não autoriza qualquer pessoa a liberar/revisar laudos.

**Evidência exigida:** Ensaio com os nove perfis, grupos iniciais, listas de serviços vazias/selecionadas e usuários inativos; diferenças explicadas e plano de recuperação validado.

<a id="bld-hpl-019"></a>

#### BLD-HPL-019 — Concessão e retirada do escopo assistencial

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Segurança + backend + operação hospitalar.

**Fontes:** [A013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A013), [H002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H002). **Depende de:** [BLD-HPL-016](#bld-hpl-016), [BLD-HPL-018](#bld-hpl-018)

**Entrega:** Gerir acesso ao paciente e vínculos assistenciais com alvo, escopo, motivo contextual e auditoria.

**Aceite:** Profissional autorizado vê o trabalho de outro autor; retirado perde acesso na próxima operação, nas listas e notificações. Atribuição de tarefa ou responsável da internação não concede paciente automaticamente. Concessão só é feita por ator que pode delegar o escopo.

**Evidência exigida:** Dois profissionais no mesmo paciente, terceiro negado, concessão/retirada e sessão aberta; verificar busca, laudo, anexo, exportação e realtime.

<a id="bld-hpl-020"></a>

#### BLD-HPL-020 — Serviços hospitalares ligados ao setor

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + gestão hospitalar.

**Fontes:** [A003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A003). **Depende de:** [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-011](#bld-hpl-011), [BLD-HPL-012](#bld-hpl-012)

**Entrega:** Ampliar catálogo para serviços diagnósticos e outras capacidades hospitalares, com setor, equipe e recursos aplicáveis.

**Aceite:** Serviço pertence a setor válido; ativação/inativação define novos pedidos e preserva os antigos. Diferenciar serviço, definição de exame e atividade executada. Mudança de setor não concede serviços implicitamente e não reescreve histórico.

**Evidência exigida:** Cadastrar serviço em setor novo, usar na operação, inativar com pendências e testar importação/reativação com acesso restrito.

<a id="bld-hpl-021"></a>

#### BLD-HPL-021 — Exames e templates publicados com histórico preservado

**Prioridade:** P0 · **Estado inicial:** PLANNED · **Responsável proposto:** Diagnóstico + backend + dados.

**Fontes:** [A004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A004), [H013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H013). **Depende de:** [BLD-HPL-008](#bld-hpl-008), [BLD-HPL-010](#bld-hpl-010), [BLD-HPL-020](#bld-hpl-020)

**Entrega:** Versionar definição de exame/template publicado e conservar a definição e faixas realmente aplicadas ao resultado.

**Aceite:** Exame publicado pode ser solicitado; alterações/importações futuras não reinterpretam laudos anteriores. Liberação exige analitos obrigatórios e referência aplicável ao contexto homologado. Não fabricar snapshots históricos ausentes: identificar limites de reconstrução e congelar novos registros. Mudança estrutural incompatível em serviço usado é negada.

**Evidência exigida:** Criar → solicitar → liberar → editar/importar catálogo → abrir laudo antigo; ensaio de migração e homologação com responsável clínico. Compartilhar conteúdo/aceite com PROD-401/403/407/408.

<a id="bld-hpl-022"></a>

#### BLD-HPL-022 — Paciente, tutor e atendimento no contexto do planner

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + equipe assistencial.

**Fontes:** [H001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H001). **Depende de:** [BLD-HPL-019](#bld-hpl-019)

**Entrega:** Completar vínculos e apresentação de tutor/paciente/atendimento necessários às tarefas assistenciais.

**Aceite:** Atividade mostra paciente e atendimento corretos, com identificação do tutor quando exigida pelo processo. Vínculos não duplicam identidade clínica e obedecem escopo, privacidade e histórico. Tarefa operacional pode existir sem paciente.

**Evidência exigida:** Pacientes com nomes semelhantes, múltiplos atendimentos e mudança de vínculo; acesso permitido/negado e validação do hospital.

### F3 — núcleo utilizável do planner

<a id="bld-hpl-023"></a>

#### BLD-HPL-023 — HospitalTask com tipos, estados e comandos próprios

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + produto hospitalar.

**Fontes:** [H003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H003), [C003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C003), [P015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P015), [P023](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P023). **Depende de:** [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-019](#bld-hpl-019)

**Entrega:** Entregar criação, consulta, edição e execução de rotina geral e assistencial em persistência, API e UI.

**Aceite:** Criar uma rotina real, localizar, iniciar e concluir com executor/horário sem serviço diagnóstico fictício. Tarefa assistencial exige contexto pertinente. Tipos e estados gerais são configuráveis sob contrato próprio; exame continua usando sua FSM e comandos. Quadro comum indica origem e fonte autoritativa.

**Evidência exigida:** Jornada por usuários operacionais autorizados e VIEWER; versão concorrente, idempotência e tentativa de usar HospitalTask para pular liberação/revisão diagnóstica.

<a id="bld-hpl-024"></a>

#### BLD-HPL-024 — Responsáveis, prioridade e datas de planejamento

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + equipe assistencial.

**Fontes:** [P025](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P025), [P026](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P026), [P029](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P029). **Depende de:** [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-023](#bld-hpl-023)

**Entrega:** Distinguir autor, responsável, equipe executora e participantes; adicionar datas planejadas/reais e reclassificação de prioridade tanto das atividades diagnósticas existentes quanto de HospitalTask por seus comandos próprios.

**Aceite:** Assumir/reatribuir é explícito, auditado e limitado a profissional elegível. Minhas atribuídas significa responsável; Meu trabalho/Na minha fila preserva todos os ativos autorizados, inclusive de outro autor. Reclassificação autorizada registra prioridade anterior/nova, ator e motivo conforme política de risco aprovada. Definir unidade da alteração (solicitação/item), efeito no dueAt e regra para itens já em execução, sem reiniciar o relógio desde a solicitação. Alterar prioridade não muda criticidade do laudo nem libera etapa clínica. Datas têm ordem válida e não confundem SLA com reserva; atribuição não altera autoria de rascunho nem concede paciente.

**Evidência exigida:** Assumir em uma interação quando elegível; reatribuição concorrente, usuário inativo/sem escopo e filtros minhas atribuídas/todo autorizado. Reclassificação permitida/negada em diagnóstico e HospitalTask, trilha/motivo aplicável, dueAt conforme política aprovada e criticidade/FSM preservadas.

<a id="bld-hpl-025"></a>

#### BLD-HPL-025 — Subtarefas e dependências rastreáveis

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + produto hospitalar.

**Fontes:** [P031](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P031), [P032](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P032). **Depende de:** [BLD-HPL-024](#bld-hpl-024)

**Entrega:** Criar composição de tarefas e relações de bloqueio com identificação da pendência e seu responsável.

**Aceite:** Recusar ciclos e ligações fora do escopo; dependência pendente bloqueia apenas o comando previsto. Concluir pai não conclui filhos/exames automaticamente. Link para exame conserva ID e autoridade clínica; reordenação não altera versão histórica.

**Evidência exigida:** Tarefas com dependência concluída/pendente, ciclo, acesso negado e conclusão concorrente; verificar FSM diagnóstica intacta. Aplicação a planos é validada na BLD-HPL-029.

<a id="bld-hpl-026"></a>

#### BLD-HPL-026 — Visões salvas e filtros consistentes

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Frontend + backend.

**Fontes:** [P030](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P030), [P048](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P048), [P049](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P049), [P050](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P050), [P075](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P075), [P076](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P076). **Depende de:** [BLD-HPL-005](#bld-hpl-005), [BLD-HPL-006](#bld-hpl-006), [BLD-HPL-024](#bld-hpl-024)

**Entrega:** Salvar visões privadas/compartilhadas com setor, responsável, tipo, prioridade e período; configurar colunas, ordem e agrupamento. O filtro por plano entra junto da BLD-HPL-029 em F4, usando o contrato de filtros desta entrega.

**Aceite:** Reaplicar visão em uma interação; os critérios significam o mesmo na Home, fila e busca. Compartilhar configuração não compartilha pacientes. Preferências incompatíveis são explicadas; filtros ativos ficam visíveis e totais correspondem à lista.

**Evidência exigida:** Duas contas, visão privada/compartilhada, setor delegado, reload e registro recém-criado oculto por filtro explícito.

<a id="bld-hpl-027"></a>

#### BLD-HPL-027 — Intake e triagem operacional

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + equipe assistencial.

**Fontes:** [P063](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P063), [P064](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P064), [P065](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P065). **Depende de:** [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023), [BLD-HPL-024](#bld-hpl-024)

**Entrega:** Receber, aceitar, rejeitar, adiar e marcar duplicidade de demandas com origem, avaliador, decisão e destino.

**Aceite:** Aceitar cria ou vincula atividade uma vez; rejeitar/adiar mantém motivo e histórico. Pedido diagnóstico ativo continua visível e usa cancelamento/rejeição clínicos corretos. Aceitar mede uma interação e rejeitar duas quando motivo pré-definido atende à política.

**Evidência exigida:** Demanda operacional e solicitação diagnóstica; repetição concorrente/idempotente, duplicidade, negado e encaminhamento entre setores autorizados.

<a id="bld-hpl-028"></a>

#### BLD-HPL-028 — Busca autorizada dos objetos do planner

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend.

**Fontes:** [P073](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P073). **Depende de:** [BLD-HPL-005](#bld-hpl-005), [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023), [BLD-HPL-026](#bld-hpl-026)

**Entrega:** Buscar tarefas e contexto assistencial; estender o mesmo índice/contrato a planos, turnos, documentos e recursos quando entregues.

**Aceite:** Resultado só inclui objeto que a pessoa pode abrir; não vaza título ou paciente em sugestão/contagem. Busca completa considera paginação e os filtros de responsabilidade/período. Objetos futuros entram com a autorização de sua entidade.

**Evidência exigida:** Pesquisa por identificação, texto e paciente com objetos próprios/delegados/negados; retirada de escopo e histórico extenso.

### F4 — atendimento, plantões e capacidade

<a id="bld-hpl-029"></a>

#### BLD-HPL-029 — Plano de trabalho do atendimento

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + equipe assistencial.

**Fontes:** [H004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H004), [P044](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P044), [P045](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P045), [P047](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P047). **Depende de:** [BLD-HPL-022](#bld-hpl-022), [BLD-HPL-025](#bld-hpl-025), [BLD-HPL-026](#bld-hpl-026)

**Entrega:** Criar plano com objetivo, período, etapas, responsáveis, tarefas e links aos exames existentes; arquivar com continuidade.

**Aceite:** Plano expõe pendências entre setores e estados derivados da fonte correta e integra filtros de visões/busca autorizadas (extensão das BLD-HPL-026/028). Mesmo exame pode ser referenciado sem duplicar execução. Encerrar/arquivar plano não cancela exame, encerra tarefa pendente ou remove histórico. Favoritar é conveniência posterior ao ciclo de vida.

**Evidência exigida:** Atendimento com tarefas e exames entre setores, etapas bloqueadas, conclusão e arquivo com pendências; total sem contagem duplicada.

<a id="bld-hpl-030"></a>

#### BLD-HPL-030 — Escala, plantões e cobertura real

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + operação hospitalar.

**Fontes:** [H005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H005), [C001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C001), [P039](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P039), [P040](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P040), [P041](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P041), [P042](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P042), [P043](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P043). **Depende de:** [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-013](#bld-hpl-013), [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029)

**Entrega:** Modelar turnos por período, profissionais, setores, cobertura, substituições e visão transversal autorizada.

**Aceite:** Validar intervalos e sobreposições proibidas; equipe vigente deriva do horário hospitalar. Transferir atividade entre turnos mantém prazo e estado. Progresso informa escopo e denominador. Preservar onCall até corte aprovado e tratar degraus de escalonamento com equipe elegível; arquivo preserva pendências.

**Evidência exigida:** Troca de turno, profissional substituto, setor delegado e fora do escopo; crítico no limite de horário, transferência concorrente e visão transversal.

<a id="bld-hpl-031"></a>

#### BLD-HPL-031 — Passagem de plantão com aceite explícito

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + equipe assistencial.

**Fontes:** [H006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H006). **Depende de:** [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030)

**Entrega:** Registrar entrega, recebimento e aceite das pendências e definir quem responde até a confirmação.

**Aceite:** Responsável anterior permanece identificado até o aceite conforme política homologada. Recebedor elegível confirma pendências sem perder exame ativo, SLA ou histórico. Aceite não concede paciente, reinicia FSM ou confirma resultado crítico automaticamente.

**Evidência exigida:** Entrega recusada, sem recebedor, troca de cobertura e dois aceites concorrentes; evidência nominal de quem assumiu cada pendência.

<a id="bld-hpl-032"></a>

#### BLD-HPL-032 — Agenda horária por recurso, profissional e sala

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + operação hospitalar.

**Fontes:** [H007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H007), [P054](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P054). **Depende de:** [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-020](#bld-hpl-020), [BLD-HPL-024](#bld-hpl-024)

**Entrega:** Criar cadastro de recursos por ID e disponibilidade; ampliar a reserva existente e diferenciar agenda do calendário de prazos.

**Aceite:** Detectar duas reservas concorrentes incompatíveis na autoridade persistente. Evento indica reserva, prazo ou execução; remarcação conserva histórico e fuso. Evoluir o conflito por recurso textual existente, sem criar fonte paralela de reserva; compartilhar aceite de US com PROD-409.

**Evidência exigida:** Profissional/sala/equipamento indisponível, reservas simultâneas, remarcação, recurso inativo e dois dispositivos em fusos diferentes.

<a id="bld-hpl-033"></a>

#### BLD-HPL-033 — Inventário de leitos, censo e transferência

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + internação.

**Fontes:** [H008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H008). **Depende de:** [BLD-HPL-012](#bld-hpl-012), [BLD-HPL-022](#bld-hpl-022), [BLD-HPL-032](#bld-hpl-032)

**Entrega:** Administrar inventário, capacidade, ocupação e transferência usando o contexto de internação existente.

**Aceite:** Leito indisponível/incompatível não recebe internação; duas ocupações simultâneas proibidas são recusadas. Censo mostra estado vigente e pendências. Transferência é transacional e alta não oculta exames ainda ativos; não duplicar a autoridade de Admission.

**Evidência exigida:** Ocupação e transferência concorrentes, bloqueio/manutenção, alta com pendências e comparação censo/contexto da internação.

<a id="bld-hpl-034"></a>

#### BLD-HPL-034 — Rotinas recorrentes e checklists versionados

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + operação hospitalar.

**Fontes:** [H009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H009). **Depende de:** [BLD-HPL-007](#bld-hpl-007), [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030)

**Entrega:** Criar modelos aprovados, recorrência durável e ocorrências com executor, horário e evidência por etapa.

**Aceite:** Repetir o job não duplica ocorrência; alterar modelo não reescreve execução anterior. Aprovação do modelo é rastreável mesmo antes da biblioteca de documentos. Concluir checklist não libera laudo, confirma crítico ou comprova administração de medicamento.

**Evidência exigida:** Recorrência na virada de plantão/dia, retry, indisponibilidade do worker, modelo revisado e etapa omitida; conciliar ocorrências previstas/geradas.

<a id="bld-hpl-035"></a>

#### BLD-HPL-035 — Procedimentos e cuidados além do diagnóstico

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Produto hospitalar + backend + equipe clínica.

**Fontes:** [H010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H010). **Depende de:** [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-034](#bld-hpl-034)

**Entrega:** Planejar e registrar execução de processos não diagnósticos aprovados, com contexto, recurso e profissional.

**Aceite:** Selecionar processos do piloto e homologar confirmação/elegibilidade por modalidade. Atividade referencia o prontuário/sistema clínico adotado e não se apresenta como prescrição ou administração medicamentosa sem contrato e validação próprios. Não exigir exame fictício para cuidado.

**Evidência exigida:** Jornada de cada processo escolhido, validação pelo responsável clínico e negativas de executor/contexto; rastrear confirmação e encaminhamento ao sistema clínico.

<a id="bld-hpl-036"></a>

#### BLD-HPL-036 — Capacidade e SLA com semântica explícita

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + produto + operação hospitalar.

**Fontes:** [H016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H016). **Depende de:** [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-033](#bld-hpl-033)

**Entrega:** Apresentar carga, disponibilidade, estimativa e prazos separadamente; integrar calendário de operação somente quando aprovado.

**Aceite:** D7/D-032 continuam contando SLA desde solicitação em horas corridas. Agenda de recursos não pausa nem recalcula esse prazo silenciosamente. Painel diferencia capacidade nominal, reservada e disponível; mudanças de política exigem decisão e exemplos homologados.

**Evidência exigida:** Recurso ocupado/indisponível, carga em vários turnos e item atrasado; conferir prazo original e denominadores de capacidade.

### F5 — colaboração, gestão e piloto

<a id="bld-hpl-037"></a>

#### BLD-HPL-037 — Comentários e anexos em tarefas

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + segurança.

**Fontes:** [P034](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P034), [P038](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P038). **Depende de:** [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-023](#bld-hpl-023)

**Entrega:** Adicionar conversa com autoria/edições e anexos que reutilizem validação, quarentena e acesso do armazenamento existente.

**Aceite:** Comentário e menção não concedem acesso; edição preserva histórico. Anexo só é aberto por pessoa autorizada ao objeto e após validação exigida. Falha de upload tem recuperação visível e não cria referência inválida.

**Evidência exigida:** Comentário entre profissionais, menção fora de escopo, edição concorrente e arquivos válidos/inválidos/quarentenados; retirada de acesso.

<a id="bld-hpl-038"></a>

#### BLD-HPL-038 — Notificações de trabalho, leitura e confirmação distintas

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + operação hospitalar.

**Fontes:** [P066](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P066), [P068](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P068). **Depende de:** [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-031](#bld-hpl-031)

**Entrega:** Implementar preferências, contadores e marcar todas lidas para eventos de conveniência, preservando alertas obrigatórios.

**Aceite:** Abrir aviso ou marcar todos lidos não confirma crítico nem aceita handover. Preferências não silenciam evento institucional obrigatório; destinatário é elegível no período e no escopo. Notificação antiga desaparece da leitura quando o objeto deixa de ser autorizado.

**Evidência exigida:** Notificação comum, crítica, handover e revogação; contagem e lista coerentes, marcar todas e preferências por usuário.

<a id="bld-hpl-039"></a>

#### BLD-HPL-039 — Documentos operacionais aprovados e versões utilizadas

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + frontend + governança clínica.

**Fontes:** [P057](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P057), [P059](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P059), [P060](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P060), [P061](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P061). **Depende de:** [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-023](#bld-hpl-023)

**Entrega:** Criar biblioteca de documentos com responsável, setor, versão vigente, aprovação, retirada e vínculo à tarefa/plano.

**Aceite:** Documento aprovado só muda por nova revisão; atividade registra a revisão utilizada. Duplicar cria identidade própria e não reescreve o original. Retirada mostra versão vigente e mantém histórico; permissões de consulta, edição e aprovação são efetivas. Favoritos são conveniência secundária.

**Evidência exigida:** Rascunho/publicação/revisão/retirada, editor negado, aprovação concorrente e tarefa usando versão anterior.

<a id="bld-hpl-040"></a>

#### BLD-HPL-040 — Indicadores de planejamento e execução

**Prioridade:** P1 · **Estado inicial:** PLANNED · **Responsável proposto:** Backend + produto + gestão hospitalar.

**Fontes:** [P069](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P069), [P070](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P070), [P071](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P071). **Depende de:** [BLD-HPL-004](#bld-hpl-004), [BLD-HPL-026](#bld-hpl-026), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-030](#bld-hpl-030), [BLD-HPL-032](#bld-hpl-032), [BLD-HPL-036](#bld-hpl-036)

**Entrega:** Medir tarefas, planos, plantões e capacidade a partir de eventos e definições versionadas de métricas.

**Aceite:** Cada indicador informa janela, escopo, denominador e origem. Separar solicitado, executado, revisado, pendente e transferido; exame em vários planos conta uma vez. Agregado corresponde à lista filtrada, incluindo setores delegados.

**Evidência exigida:** Fixture com números esperados, duplicação de vínculos, setores delegados, troca de filtro e definição de medida homologada.

<a id="bld-hpl-041"></a>

#### BLD-HPL-041 — Relatórios salvos e exportação operacional

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Backend + frontend + privacidade.

**Fontes:** [P072](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P072), [P079](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P079). **Depende de:** [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-040](#bld-hpl-040)

**Entrega:** Salvar definições de relatórios e exportar visão autorizada em formatos escolhidos, com acompanhamento de jobs.

**Aceite:** Exportação reproduz filtros/janela/definição e checa acesso ao gerar e ao baixar. Registrar operação quando aplicável; distinguir exportação operacional do fluxo LGPD existente. Revogação impede download pendente fora do escopo.

**Evidência exigida:** Relatório por setor delegado, job com falha/retry e retirada de acesso antes do download; reconciliação linhas da exportação/lista.

<a id="bld-hpl-042"></a>

#### BLD-HPL-042 — Integrações HIS/LIS/PACS e contratos externos

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Integração + segurança + TI hospitalar.

**Fontes:** [P080](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P080), [P081](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P081), [P082](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P082), [H017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H017). **Depende de:** [BLD-HPL-019](#bld-hpl-019), [BLD-HPL-021](#bld-hpl-021), [BLD-HPL-023](#bld-hpl-023)

**Entrega:** Selecionar sistemas efetivamente usados, publicar contratos versionados e credenciais de serviço limitadas; entregar conectores contratados.

**Aceite:** Token tem finalidade, escopo, validade, rotação e revogação. Mensagem repetida não duplica atividade; webhooks autenticados têm retry, logs e recuperação. Integração aplica os mesmos comandos, versões e autorização; conteúdo clínico limita-se à finalidade. Obrigatória apenas se uma jornada do piloto depender dela.

**Evidência exigida:** Sandbox do sistema adotado, duplicidade/out-of-order, revogação, assinatura inválida, falha recuperável e rastreio de identificadores.

### F6 — conveniências e expansões opcionais

<a id="bld-hpl-043"></a>

#### BLD-HPL-043 — Configuração institucional, convites e capacidades por setor

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Produto + frontend + backend.

**Fontes:** [P001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P001), [P003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P003), [P013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P013), [P014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P014). **Depende de:** [BLD-HPL-012](#bld-hpl-012), [BLD-HPL-018](#bld-hpl-018)

**Entrega:** Ampliar configuração institucional, entrada por convite, capacidades por setor e arquivo/restauração de espaços de trabalho.

**Aceite:** Convite admite apenas acesso autorizado e revogável; habilitar módulo não concede comandos. Arquivo do setor/espaço não remove pendências nem altera histórico. Multiunidade só entra com limite de isolamento e necessidade confirmados; não impor slug de SaaS ao hospital.

**Evidência exigida:** Convite expirado/revogado, módulo desabilitado, setor arquivado com pendências e isolamento entre unidades quando adotado.

<a id="bld-hpl-044"></a>

#### BLD-HPL-044 — Perfil, favoritos, recentes e notas pessoais

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Frontend + produto.

**Fontes:** [P005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P005), [P006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P006), [P007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P007), [P008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P008). **Depende de:** [BLD-HPL-006](#bld-hpl-006), [BLD-HPL-028](#bld-hpl-028)

**Entrega:** Adicionar atalhos e personalização individual que reduzam navegação sem ampliar acesso.

**Aceite:** Perfil e favoritos pertencem à pessoa; recentes só abrem recursos ainda autorizados. Nota pessoal não se torna prontuário nem é mostrada para outra conta. Classificar notas como P3, sem bloquear demais atalhos P2.

**Evidência exigida:** Troca de conta, recurso revogado/arquivado, persistência individual e navegação por teclado.

<a id="bld-hpl-045"></a>

#### BLD-HPL-045 — Detalhes avançados e acompanhamento de atividades

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Produto + frontend + backend.

**Fontes:** [P016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P016), [P019](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P019), [P027](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P027), [P028](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P028), [P033](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P033), [P035](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P035), [P036](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P036), [P046](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P046). **Depende de:** [BLD-HPL-024](#bld-hpl-024), [BLD-HPL-029](#bld-hpl-029), [BLD-HPL-037](#bld-hpl-037), [BLD-HPL-038](#bld-hpl-038)

**Entrega:** Evoluir descrições ricas, drafts, estimativas, labels, referências, assinatura de atividade e links de plano.

**Aceite:** Draft não aparece como execução; estimativa não equivale a duração real. Labels/referências obedecem escopo; seguir/menção não concede paciente. Conteúdo rico é validado. Reações P3 permanecem opcionais e não significam confirmação clínica.

**Evidência exigida:** Draft publicado/cancelado, filtro de labels, assinante sem escopo, link externo e validação de conteúdo rico.

<a id="bld-hpl-046"></a>

#### BLD-HPL-046 — Operações em lote com resultado por item

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Backend + frontend + segurança.

**Fontes:** [P021](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P021). **Depende de:** [BLD-HPL-009](#bld-hpl-009), [BLD-HPL-018](#bld-hpl-018), [BLD-HPL-023](#bld-hpl-023)

**Entrega:** Arquivar/restaurar atividades e avaliar outras ações em lote autorizadas, conservando resultado individual.

**Aceite:** Cada item tem comando, versão e autorização próprios; falha parcial é explícita e retry não duplica efeito. Item clínico não sofre exclusão física ou mudança genérica de estado. Arquivo não esconde pendência ativa.

**Evidência exigida:** Lote misto permitido/negado/conflitante, repetição idempotente e registro ativo protegido; medir interações da operação.

<a id="bld-hpl-047"></a>

#### BLD-HPL-047 — Gantt e edição em tabela

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Frontend + backend.

**Fontes:** [P055](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P055), [P056](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P056). **Depende de:** [BLD-HPL-025](#bld-hpl-025), [BLD-HPL-032](#bld-hpl-032)

**Entrega:** Expor cronograma com datas/dependências reais e edição somente das propriedades autorizadas.

**Aceite:** Alterar célula ou barra usa o mesmo contrato de concorrência e autorização. Dependência, conflito de recurso e trava clínica continuam vigentes; propriedades sem comando editável permanecem de leitura.

**Evidência exigida:** Edição concorrente, recurso em conflito, dependência pendente e perfis de leitura; acessibilidade das ações.

<a id="bld-hpl-048"></a>

#### BLD-HPL-048 — Editor rico e coedição de documentos

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Frontend + backend + governança clínica.

**Fontes:** [P058](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P058), [P062](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P062). **Depende de:** [BLD-HPL-039](#bld-hpl-039)

**Entrega:** Ampliar editor e avaliar coedição sobre o ciclo de aprovação e versionamento já entregue.

**Aceite:** Autores e alterações são rastreáveis; edição simultânea não muda documento aprovado sem revisão. Permissão retirada encerra participação antes de emitir conteúdo e conteúdo rico é validado.

**Evidência exigida:** Dois editores, conflito, publicação concorrente, conteúdo inválido e revogação durante coedição.

<a id="bld-hpl-049"></a>

#### BLD-HPL-049 — Arquivo pessoal de notificações

**Prioridade:** P2 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Frontend + backend.

**Fontes:** [P067](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P067). **Depende de:** [BLD-HPL-038](#bld-hpl-038)

**Entrega:** Organizar avisos pessoais sem remover obrigações assistenciais.

**Aceite:** Arquivar aviso não confirma resultado crítico, aceita passagem ou encerra pendência. Eventos obrigatórios continuam identificáveis; arquivo e restauração obedecem ao acesso atual ao objeto.

**Evidência exigida:** Arquivar comum/crítico/handover, restaurar após perda de escopo e conferir contadores obrigatórios.

<a id="bld-hpl-050"></a>

#### BLD-HPL-050 — Assistência de IA opcional e revisável

**Prioridade:** P3 · **Estado inicial:** OPCIONAL · **Responsável proposto:** Produto + privacidade + equipe clínica.

**Fontes:** [P083](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P083). **Depende de:** [BLD-HPL-039](#bld-hpl-039), [BLD-HPL-045](#bld-hpl-045)

**Entrega:** Investigar uso de sugestões de texto após os fluxos básicos, com finalidade e tratamento de dados definidos.

**Aceite:** Proposta de uso e fornecedor exige decisão específica antes de transmitir dados reais. Texto sugerido é revisado pelo responsável; IA não libera resultado, prescreve, confirma crítico ou executa comando clínico. Não é condição de aceite do planner.

**Evidência exigida:** Avaliação de utilidade e dados em ambiente controlado, autoria da revisão e tentativas de executar ações sem confirmação.

<a id="bld-hpl-051"></a>

### BLD-HPL-051 — Homologação, piloto e gates de release

**Prioridade:** P0 de release · **Estado inicial:** PLANNED · **Responsáveis propostos:** produto, responsável clínico, gestão, QA e TI/operação.

**Origem:** objetivo hospitalar aprovado como direção; gate adicional, sem criar uma 138ª linha na matriz.

**Depende de:** BLD-HPL-001–040; entregas opcionais apenas quando incluídas no escopo do piloto. PROD-703 continua dono do piloto institucional; PROD-604/605 dos gates técnicos/revisão e os demais gates permanecem no [backlog de produção](PRODUCTION_BACKLOG.md). As fases podem ter releases técnicas intermediárias sem afirmar que o planner completo já foi entregue.

**Aceite:** uma equipe autorizada configura setor → serviço/exame → usuário/grupo → vínculo assistencial; usuário normal cria demanda, localiza registro, atribui tarefa, acompanha plano, reserva recurso e passa plantão com aceite. ADMIN técnico, SUPERADMIN, gestores e profissionais executam apenas seus comandos. Revalidar as 15 garantias; zero defeito P0 aberto no escopo. Conteúdo clínico, carga, restore, observabilidade, infraestrutura e operação são validados no alvo; nomes e datas do piloto são registrados antes de iniciar.

**Evidência exigida:** commit/imagem/schema identificados, comparação de permissões antes/depois, jornadas em desktop/tablet/mobile, medição de usabilidade com usuários, teste de carga com volume alvo, restore completo e aceite nominal. Registrar limitações/achados remanescentes e retorno ao backlog. Usar o [pacote preenchível de UAT e piloto](../operations/HOSPITAL_PLANNER_PILOT.md) para cenários, contas/escopos, resultados e assinaturas. Não certificar disponibilidade ou go-live apenas com testes locais.

## 4. Garantias existentes a preservar

`FACT` — Os 15 itens abaixo foram classificados Conforme na avaliação. São invariantes de regressão, não tarefas novas concluídas. Toda fatia que os afeta precisa mostrar que os preserva; a validação conjunta entra em BLD-HPL-051.

| Registro | Fonte | Garantia / aceite de preservação |
| --- | --- | --- |
| <a id="inv-hpl-01"></a>INV-HPL-01 | [P004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P004) | Revogação e saída de membros seguem valendo na autorização corrente. |
| <a id="inv-hpl-02"></a>INV-HPL-02 | [P010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P010) | Setor/projeto restrito não expõe conteúdo clínico por participação genérica. |
| <a id="inv-hpl-03"></a>INV-HPL-03 | [P017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P017) | Identificador humano e link direto continuam abrindo o objeto autorizado. |
| <a id="inv-hpl-04"></a>INV-HPL-04 | [P024](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P024) | Estado inicial é definido pelo contrato, sem escolha clínica arbitrária. |
| <a id="inv-hpl-05"></a>INV-HPL-05 | [P037](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P037) | Histórico auditado mantém autoria e ordenação rastreáveis. |
| <a id="inv-hpl-06"></a>INV-HPL-06 | [P052](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P052) | Lista abre detalhe autorizado e mostra estado, prazo e próxima ação. |
| <a id="inv-hpl-07"></a>INV-HPL-07 | [P053](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P053) | Kanban e teclado usam os mesmos comandos válidos do servidor. |
| <a id="inv-hpl-08"></a>INV-HPL-08 | [P074](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P074) | Busca por setor não amplia escopo e continua completa com paginação. |
| <a id="inv-hpl-09"></a>INV-HPL-09 | [P077](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P077) | Arquivamento/retenção preserva registros e não oculta pendência ativa. |
| <a id="inv-hpl-10"></a>INV-HPL-10 | [H011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H011) | FSM, elegibilidade, versão, idempotência e autoridade de estado diagnóstica são preservadas. |
| <a id="inv-hpl-11"></a>INV-HPL-11 | [H012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H012) | Amostra, accession e recoleta conservam linhagem e material válido. |
| <a id="inv-hpl-12"></a>INV-HPL-12 | [H014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H014) | Confirmação de crítico é explícita; leitura de inbox não confirma e escalonamento mantém destinatário elegível. |
| <a id="inv-hpl-13"></a>INV-HPL-13 | [H015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H015) | Privacidade, retenção e auditoria aplicam-se também a tarefas, grupos e integrações. |
| <a id="inv-hpl-14"></a>INV-HPL-14 | [A005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A005) | Catálogo de exame e exame do paciente têm identidades e comandos separados; snapshot histórico é BLD-HPL-021. |
| <a id="inv-hpl-15"></a>INV-HPL-15 | [A017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A017) | Último administrador, limites ADMIN/MANAGER/SUPERADMIN, reautenticação exigida, versão e auditoria continuam protegidos. |

## 5. Fora do escopo comprometido

`DECISION` — Não aplicável ao objetivo atual; um pedido futuro exige escopo e decisão próprios, sem reabrir automaticamente estas linhas.

| Registro | Fonte | Disposição |
| --- | --- | --- |
| <a id="out-hpl-01"></a>OUT-HPL-01 | [P002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P002) | Slug de workspace SaaS não é requisito do hospital; códigos institucionais/setoriais têm contrato próprio. |
| <a id="out-hpl-02"></a>OUT-HPL-02 | [P020](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P020) | Exclusão física em lote de registros clínicos não entra; cancelar/arquivar usa comando auditado e retenção legal. |
| <a id="out-hpl-03"></a>OUT-HPL-03 | [P078](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P078) | Inatividade não comprova procedimento concluído ou laudo revisado; automação pode lembrar/escalonar. |
| <a id="out-hpl-04"></a>OUT-HPL-04 | [H018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H018) | ERP completo, faturamento e estoque não fazem parte deste planner; integração administrativa tem escopo separado. |

## 6. Investigação opcional dos limites da referência

`OPEN QUESTION` — A existência comercial ou um stub de código não comprova capacidade no Plane Community inspecionado. Só investigar quando houver necessidade hospitalar; cada investigação deve terminar em decisão escrita: atendido pelo núcleo, implementar com contrato próprio, contratar após verificação ou descartar. Estes seis registros não bloqueiam as fases básicas.

| Registro | Fonte | Pergunta/saída exigida | Entregas relacionadas |
| --- | --- | --- | --- |
| <a id="disc-hpl-01"></a>DISC-HPL-01 | [C002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C002) | Validar se planos e subtarefas já cobrem a necessidade; a modal CE vazia não comprova feature. | [BLD-HPL-025](#bld-hpl-025) / [BLD-HPL-029](#bld-hpl-029) |
| <a id="disc-hpl-02"></a>DISC-HPL-02 | [C004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C004) | Definir casos hospitalares concretos, validação, autorização e versionamento; não assumir capacidade da extensão CE. | [BLD-HPL-023](#bld-hpl-023) |
| <a id="disc-hpl-03"></a>DISC-HPL-03 | [C005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C005) | Inspecionar/contratar apenas se necessárias; coedição CE verificada tem entrega própria e não depende dessa extensão. | [BLD-HPL-039](#bld-hpl-039) / [BLD-HPL-048](#bld-hpl-048) |
| <a id="disc-hpl-04"></a>DISC-HPL-04 | [C006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C006) | Verificar contrato do sistema adotado; serviços sem rota CE não constituem integração disponível. | [BLD-HPL-042](#bld-hpl-042) |
| <a id="disc-hpl-05"></a>DISC-HPL-05 | [C007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C007) | Homologar semântica de tempo real vs estimativa e necessidade de apontamento manual; flag CE não comprova fluxo. | [BLD-HPL-024](#bld-hpl-024) / [BLD-HPL-040](#bld-hpl-040) / [BLD-HPL-045](#bld-hpl-045) |
| <a id="disc-hpl-06"></a>DISC-HPL-06 | [C008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C008) | Definir ator, objeto, versão e histórico por processo; não usar como requisito de compra nem tornar a FSM diagnóstica editável. | [BLD-HPL-023](#bld-hpl-023) / [BLD-HPL-035](#bld-hpl-035) / [BLD-HPL-039](#bld-hpl-039) |

## 7. Reconciliação com os backlogs anteriores

Este backlog é dono da evolução hospitalar HPL; [IMPROVEMENT_BACKLOG_2026-10.md](IMPROVEMENT_BACKLOG_2026-10.md) conserva o histórico IMP e [PRODUCTION_BACKLOG.md](PRODUCTION_BACKLOG.md) conserva o caminho de go-live. Usar uma implementação e uma evidência compartilhada quando os IDs abaixo coincidem; não executar duas vezes o mesmo trabalho.

| Registro anterior | Destino / regra |
| --- | --- |
| UX-01 | BLD-HPL-024: responsável e minha fila; retirar filtro implícito de autor não equivale a implementar atribuição. |
| UX-02 | BLD-HPL-006/026: visões e preferências. |
| UX-03 | BLD-HPL-027: intake com distinção do workflow diagnóstico. |
| UX-04 | BLD-HPL-012/013/014/020/021 e gate 051: jornada de configuração de setores, serviços/exames e usuários, sem supor cadastro pronto por haver sugestões de código. |
| UX-05 | BLD-HPL-023: estados de tarefa geral; FSM diagnóstica segue fixa e autoritativa. |
| UX-06 | BLD-HPL-046/024: lote e atribuição são opções após o contrato individual. |
| UX-07 / PROD-407 | Importação de catálogo existente é reutilizada; eventual importação de usuários recebe requisito próprio quando selecionada, não é promessa adicional neste escopo. |
| UX-08 | Atalhos podem ser incorporados às jornadas 024/026/044; não criar segundo fluxo de comandos. |
| UX-09 | BLD-HPL-038: lido, confirmação crítica e aceite de handover permanecem distintos. |
| UX-10 / PROD-703 | BLD-HPL-051 compartilha medição de uso e piloto institucional. |
| UX-11 / PROD-201 | Troca de senha já existe em Minha conta; o BLOCKED antigo de UX-11 não cria uma nova pendência. |
| COR-10 | BLD-HPL-009 altera o contrato antigo de acesso implícito; DONE histórico não atende ao novo aceite de None/seleção/todos/futuros. |
| COR-11 | BLD-HPL-012/013: sugestões de setor não são Department CRUD. |
| PROD-401/403/407/408 | BLD-HPL-021 compartilha conteúdo diagnóstico e homologação; não duplica listas clínicas nem afirma que já foram aprovadas. |
| PROD-404 / D7 / D-032 | BLD-HPL-007/036 conserva SLA em horas corridas desde a solicitação; agenda não altera a política. |
| PROD-409 | BLD-HPL-032 amplia reserva/agenda existente e compartilha o aceite de US. |
| PROD-501/502, PROD-511–516 | Gates existentes de privacidade, retenção, observabilidade, backup e operação continuam com seus donos. |
| PROD-111 / TEC-01 / D-061 | Reavaliar volume/modelo das novas entidades dentro da decisão de persistência existente; não exigir cutover relacional por simples analogia com Plane/HIS. |

Os resumos antigos não são usados como status desta versão: a troca de senha UX-11 e a situação de PROD-003 possuem atualizações posteriores nos registros específicos. Em caso de divergência, consultar evidência/commit e atualizar a fonte apropriada durante execução. Nenhuma correção histórica é declarada concluída por esta documentação.

## 8. Rastreabilidade completa — 137 itens

Cada linha aponta um destino primário único. Situação e prioridade são as da avaliação, e não o estado de execução do backlog. Critérios detalhados e evidências de código permanecem no [JSON](../avaliacoes/plane-preview-2026-10-11/matriz.json) e no detalhe de cada fonte.

| Fonte | Capacidade avaliada | Situação de origem | Pri de origem | Disposição | Destino primário |
| --- | --- | --- | --- | --- | --- |
| [P001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P001) | Workspace: criar, listar e editar | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-043](#bld-hpl-043) |
| [P002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P002) | Verificar slug de workspace | Não aplicável | P3 | FORA DO ESCOPO | [OUT-HPL-01](#out-hpl-01) |
| [P003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P003) | Convites e aceite de adesão | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-043](#bld-hpl-043) |
| [P004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P004) | Membros e saída do workspace | Conforme | P2 | PRESERVAR | [INV-HPL-01](#inv-hpl-01) |
| [P005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P005) | Perfil e atividade de usuário | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-044](#bld-hpl-044) |
| [P006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P006) | Favoritos e grupos de favoritos | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-044](#bld-hpl-044) |
| [P007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P007) | Links recentes e home personalizada | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-044](#bld-hpl-044) |
| [P008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P008) | Notas adesivas | Ausente | P3 | IMPLEMENTAR | [BLD-HPL-044](#bld-hpl-044) |
| [P009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P009) | Projetos: criar, listar e editar | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-012](#bld-hpl-012) |
| [P010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P010) | Projeto público ou secreto | Conforme | P0 | PRESERVAR | [INV-HPL-02](#inv-hpl-02) |
| [P011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P011) | Membros e convites por projeto | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-013](#bld-hpl-013) |
| [P012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P012) | Líder e responsável padrão do projeto | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-013](#bld-hpl-013) |
| [P013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P013) | Ativar funcionalidades por projeto | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-043](#bld-hpl-043) |
| [P014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P014) | Arquivar e restaurar projetos | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-043](#bld-hpl-043) |
| [P015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P015) | Criar, editar e excluir work item | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-023](#bld-hpl-023) |
| [P016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P016) | Descrição rica do work item | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P017) | Abrir pelo identificador humano | Conforme | P2 | PRESERVAR | [INV-HPL-03](#inv-hpl-03) |
| [P018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P018) | Leitura paginada de work items | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-005](#bld-hpl-005) |
| [P019](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P019) | Draft e conversão em work item | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P020](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P020) | Exclusão de itens em lote | Não aplicável | P0 | FORA DO ESCOPO | [OUT-HPL-02](#out-hpl-02) |
| [P021](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P021) | Arquivar em lote e restaurar item | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-046](#bld-hpl-046) |
| [P022](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P022) | Versões do item e da descrição | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-008](#bld-hpl-008) |
| [P023](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P023) | Estados configuráveis por projeto | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-023](#bld-hpl-023) |
| [P024](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P024) | Estado padrão do projeto | Conforme | P2 | PRESERVAR | [INV-HPL-04](#inv-hpl-04) |
| [P025](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P025) | Prioridade de work item | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-024](#bld-hpl-024) |
| [P026](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P026) | Múltiplos assignees | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-024](#bld-hpl-024) |
| [P027](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P027) | Esquemas e pontos de estimativa | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P028](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P028) | Labels com CRUD e criação em lote | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P029](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P029) | Data de início e prazo | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-024](#bld-hpl-024) |
| [P030](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P030) | Propriedades visíveis por usuário | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P031](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P031) | Subitems e parent | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-025](#bld-hpl-025) |
| [P032](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P032) | Relações e dependências | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-025](#bld-hpl-025) |
| [P033](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P033) | Links externos do work item | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P034](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P034) | Comentários editáveis | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-037](#bld-hpl-037) |
| [P035](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P035) | Reações de itens e comentários | Ausente | P3 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P036](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P036) | Subscriptions de work items | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P037](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P037) | Atividade histórica do item | Conforme | P0 | PRESERVAR | [INV-HPL-05](#inv-hpl-05) |
| [P038](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P038) | Anexos com upload e download | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-037](#bld-hpl-037) |
| [P039](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P039) | Criar, editar e listar ciclos | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [P040](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P040) | Validar datas do ciclo | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [P041](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P041) | Associar e transferir itens entre ciclos | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [P042](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P042) | Favoritar e arquivar ciclos | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [P043](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P043) | Progresso e analytics do ciclo | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [P044](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P044) | Criar, editar e listar módulos | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-029](#bld-hpl-029) |
| [P045](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P045) | Associar itens a módulos | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-029](#bld-hpl-029) |
| [P046](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P046) | Links do módulo | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-045](#bld-hpl-045) |
| [P047](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P047) | Favoritos e arquivo de módulos | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-029](#bld-hpl-029) |
| [P048](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P048) | Views salvas por projeto | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P049](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P049) | Views entre projetos do workspace | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P050](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P050) | View privada ou compartilhada | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P051](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P051) | Favoritos filtros e apresentação persistidos | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-006](#bld-hpl-006) |
| [P052](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P052) | Layout Lista | Conforme | P2 | PRESERVAR | [INV-HPL-06](#inv-hpl-06) |
| [P053](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P053) | Layout Kanban | Conforme | P0 | PRESERVAR | [INV-HPL-07](#inv-hpl-07) |
| [P054](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P054) | Layout Calendário | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-032](#bld-hpl-032) |
| [P055](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P055) | Layout Gantt | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-047](#bld-hpl-047) |
| [P056](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P056) | Layout Spreadsheet | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-047](#bld-hpl-047) |
| [P057](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P057) | Criar editar e listar Pages | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-039](#bld-hpl-039) |
| [P058](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P058) | Editor rico de Pages | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-048](#bld-hpl-048) |
| [P059](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P059) | Favoritos e arquivo de Pages | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-039](#bld-hpl-039) |
| [P060](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P060) | Lock e controle de acesso de Pages | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-039](#bld-hpl-039) |
| [P061](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P061) | Versões e duplicação de Pages | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-039](#bld-hpl-039) |
| [P062](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P062) | Edição colaborativa simultânea | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-048](#bld-hpl-048) |
| [P063](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P063) | CRUD do Intake | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-027](#bld-hpl-027) |
| [P064](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P064) | Enviar work item ao Intake | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-027](#bld-hpl-027) |
| [P065](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P065) | Aceitar rejeitar adiar e marcar duplicado | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-027](#bld-hpl-027) |
| [P066](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P066) | Marcar lida e não lida | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-038](#bld-hpl-038) |
| [P067](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P067) | Arquivar notificações | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-049](#bld-hpl-049) |
| [P068](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P068) | Contador preferências e marcar todas lidas | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-038](#bld-hpl-038) |
| [P069](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P069) | Overview analytics | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-040](#bld-hpl-040) |
| [P070](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P070) | Work item analytics | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-040](#bld-hpl-040) |
| [P071](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P071) | Stats e charts com filtros | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-040](#bld-hpl-040) |
| [P072](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P072) | Analytics salvos e exportação | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-041](#bld-hpl-041) |
| [P073](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P073) | Busca global e de entidades | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-028](#bld-hpl-028) |
| [P074](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P074) | Busca de itens por projeto | Conforme | P2 | PRESERVAR | [INV-HPL-08](#inv-hpl-08) |
| [P075](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P075) | Filtros por estado, prioridade, assignee, labels, datas, ciclo e módulo | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P076](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P076) | Agrupar ordenar e configurar apresentação | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-026](#bld-hpl-026) |
| [P077](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P077) | Autoarquivar itens | Conforme | P0 | PRESERVAR | [INV-HPL-09](#inv-hpl-09) |
| [P078](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P078) | Fechar automaticamente por inatividade | Não aplicável | P0 | FORA DO ESCOPO | [OUT-HPL-03](#out-hpl-03) |
| [P079](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P079) | Exportar CSV, XLSX e JSON e consultar jobs | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-041](#bld-hpl-041) |
| [P080](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P080) | API tokens | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-042](#bld-hpl-042) |
| [P081](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P081) | API externa de work items e recursos associados | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-042](#bld-hpl-042) |
| [P082](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P082) | Webhooks com gestão logs e rotação | Parcial | P2 | IMPLEMENTAR | [BLD-HPL-042](#bld-hpl-042) |
| [P083](../avaliacoes/plane-preview-2026-10-11/relatorio.html#P083) | IA configurável | Ausente | P3 | IMPLEMENTAR | [BLD-HPL-050](#bld-hpl-050) |
| [C001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C001) | Ciclos ativos de todo workspace | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [C002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C002) | Epics | Não verificável | P3 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-01](#disc-hpl-01) |
| [C003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C003) | Tipos customizados de work item | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-023](#bld-hpl-023) |
| [C004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C004) | Propriedades customizadas | Não verificável | P2 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-02](#disc-hpl-02) |
| [C005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C005) | Extensões comerciais de Pages | Não verificável | P3 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-03](#disc-hpl-03) |
| [C006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C006) | Importadores GitHub Jira e sincronização | Não verificável | P2 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-04](#disc-hpl-04) |
| [C007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C007) | Time tracking | Não verificável | P2 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-05](#disc-hpl-05) |
| [C008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#C008) | Workflows e aprovações comerciais | Não verificável | P2 | INVESTIGAR SE NECESSÁRIO | [DISC-HPL-06](#disc-hpl-06) |
| [H001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H001) | Contexto de paciente e tutor | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-022](#bld-hpl-022) |
| [H002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H002) | Compartilhar cuidado autorizado | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-019](#bld-hpl-019) |
| [H003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H003) | Tarefas gerais do hospital | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-023](#bld-hpl-023) |
| [H004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H004) | Plano de trabalho do atendimento | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-029](#bld-hpl-029) |
| [H005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H005) | Escala e plantão real | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-030](#bld-hpl-030) |
| [H006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H006) | Passagem de plantão com aceite | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-031](#bld-hpl-031) |
| [H007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H007) | Agenda por recurso, profissional e sala | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-032](#bld-hpl-032) |
| [H008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H008) | Censo e ocupação de leitos | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-033](#bld-hpl-033) |
| [H009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H009) | Rotinas recorrentes e checklists | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-034](#bld-hpl-034) |
| [H010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H010) | Procedimentos além de diagnóstico | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-035](#bld-hpl-035) |
| [H011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H011) | Comandos clínicos e concorrência | Conforme | P0 | PRESERVAR | [INV-HPL-10](#inv-hpl-10) |
| [H012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H012) | Amostras, recoleta e linhagem | Conforme | P0 | PRESERVAR | [INV-HPL-11](#inv-hpl-11) |
| [H013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H013) | Resultados e referências laboratoriais | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-021](#bld-hpl-021) |
| [H014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H014) | Resultado crítico, confirmação e escalonamento | Conforme | P0 | PRESERVAR | [INV-HPL-12](#inv-hpl-12) |
| [H015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H015) | Auditoria, privacidade e retenção | Conforme | P0 | PRESERVAR | [INV-HPL-13](#inv-hpl-13) |
| [H016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H016) | SLA e capacidade dimensionados | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-036](#bld-hpl-036) |
| [H017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H017) | Conectores HIS LIS PACS | Ausente | P2 | IMPLEMENTAR | [BLD-HPL-042](#bld-hpl-042) |
| [H018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#H018) | Faturamento estoque e ERP completo | Não aplicável | P3 | FORA DO ESCOPO | [OUT-HPL-04](#out-hpl-04) |
| [D001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D001) | Navegação consistente de configurações | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-001](#bld-hpl-001) |
| [D002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D002) | Ações compatíveis com permissões | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-002](#bld-hpl-002) |
| [D003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D003) | Confirmação localizável após criar | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-003](#bld-hpl-003) |
| [D004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D004) | Resumo e lista com o mesmo escopo | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-004](#bld-hpl-004) |
| [D005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D005) | Histórico completo e continuidade | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-005](#bld-hpl-005) |
| [D006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D006) | Preferências individuais persistentes | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-006](#bld-hpl-006) |
| [D007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D007) | Datas com fuso coerente | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-007](#bld-hpl-007) |
| [D008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#D008) | Navegar conteúdo das versões | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-008](#bld-hpl-008) |
| [A001](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A001) | Cadastro completo de setores | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-012](#bld-hpl-012) |
| [A002](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A002) | Integração do setor com usuários, filas e serviços | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-013](#bld-hpl-013) |
| [A003](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A003) | Catálogo de serviços hospitalares | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-020](#bld-hpl-020) |
| [A004](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A004) | Definição de exame e modelo de resultado | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-021](#bld-hpl-021) |
| [A005](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A005) | Separar exame do catálogo e exame do paciente | Conforme | P0 | PRESERVAR | [INV-HPL-14](#inv-hpl-14) |
| [A006](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A006) | Criação e edição completa de usuários | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-014](#bld-hpl-014) |
| [A007](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A007) | Distinguir nenhum, seleção e todos os exames | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-009](#bld-hpl-009) |
| [A008](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A008) | Cadastro de grupos de acesso | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-015](#bld-hpl-015) |
| [A009](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A009) | Vincular usuário ao grupo e migrar os perfis atuais | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-018](#bld-hpl-018) |
| [A010](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A010) | Catálogo de permissões por recurso e comando | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-010](#bld-hpl-010) |
| [A011](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A011) | Editor de matriz com autorização real por ação | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-015](#bld-hpl-015) |
| [A012](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A012) | Consultar permissões efetivas de uma pessoa | Ausente | P1 | IMPLEMENTAR | [BLD-HPL-017](#bld-hpl-017) |
| [A013](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A013) | Gestão explícita de escopos clínicos | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-019](#bld-hpl-019) |
| [A014](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A014) | Concessão de acesso quando entra um exame novo | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-009](#bld-hpl-009) |
| [A015](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A015) | Delegação limitada de permissões e grupos | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-016](#bld-hpl-016) |
| [A016](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A016) | Revogação e inativação com efeito definido | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-016](#bld-hpl-016) |
| [A017](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A017) | Proteção de contas administrativas | Conforme | P0 | PRESERVAR | [INV-HPL-15](#inv-hpl-15) |
| [A018](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A018) | Ciclo de vida e auditoria dos cadastros | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-011](#bld-hpl-011) |
| [A019](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A019) | Uma política para menu, botão e API | Parcial | P0 | IMPLEMENTAR | [BLD-HPL-002](#bld-hpl-002) |
| [A020](../avaliacoes/plane-preview-2026-10-11/relatorio.html#A020) | Verificação da matriz de acesso | Parcial | P1 | IMPLEMENTAR | [BLD-HPL-010](#bld-hpl-010) |

## 9. Registro de execução por entrega

Ao iniciar, atualizar o estado no acompanhamento da execução e acrescentar a evidência abaixo no item correspondente, preservando a coluna “Estado inicial” da fila. Identificar a árvore candidata e, quando criado, seu commit; não preencher com resultado de outra versão.

| Campo | Registro obrigatório |
| --- | --- |
| Estado / responsável | IN_PROGRESS ou DONE, pessoa nomeada e data. |
| Versão | Commit candidato, schema/migration e imagem quando aplicáveis. |
| Aceite | Cenários satisfeitos, incluindo negativas e invariantes afetadas. |
| Evidência | Caminho/artefato ou execução de CI correspondente ao candidato. |
| Migração/operação | Efeito nos dados atuais, procedimento de atualização e recuperação. |
| Limites restantes | Lacunas, decisões e itens reabertos com destino explícito. |
