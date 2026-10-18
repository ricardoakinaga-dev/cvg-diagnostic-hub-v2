# Auditoria literal e correções de acesso do planner

**Captura:** 12/10/2026 · **Estado:** correções focadas verificadas; nova CI completa e imagens pendentes · **Piloto:** não iniciado · **Release:** não aplicada.

A auditoria conferiu os critérios das **50 entregas selecionadas**, incluindo 041–050, e do **gate 051**. A rastreabilidade preserva **137 itens, 15 garantias e dependências sem ciclos**. O [registro estruturado](HOSPITAL_PLANNER_LITERAL_ACCEPTANCE_FOLLOWUP_2026-10-12.json) conserva os pareceres por requisito, as evidências históricas e as correções posteriores; não declara aceite hospitalar.

O [manifesto desta captura](HOSPITAL_PLANNER_LITERAL_ACCEPTANCE_SOURCE_MANIFEST_2026-10-12.json) identifica **1091 inputs**, fingerprint `277f198daddcea9fe48943a3f48eab84ef4df9270d21553138b6270295c5a89e`. A base Git é `bc4ccada`; a fonte capturada ainda não era commit. Comparada à candidata anterior, há 29 inputs alterados, 1 adicionados e 0 removidos. Os 1061 inputs idênticos conservam proveniência; isso não transfere a aprovação da CI inteira.

## Defeitos corrigidos

| Entrega | Defeito e comportamento atual |
| --- | --- |
| 001 | Gestão apontava para auditoria, mas o console recusava o perfil. Agora a leitura autorizada chega ao conteúdo no escopo; menus técnicos de desktop e mobile seguem as capacidades efetivas. |
| 002 | Botões de paciente, solicitação, atendimento e catálogo usavam apenas perfil ou grants amplos. Agora cada ação usa a permissão nativa correspondente, inclusive grupos reduzidos. Alterações de acesso retiram as ações e respostas antigas não restauram permissões. Exportação LGPD exige seu próprio grant. |
| 012 | A desativação de setor não mostrava pendências. Agora consulta exames, tarefas e demandas visíveis antes de confirmar; “sem acesso” é diferente de zero. Falha, versão alterada ou preview retirado impede a confirmação. Trabalho e vínculos existentes são preservados. |
| 021 | O veterinário autorizado a aprovar definições não alcançava o editor pela UI. O catálogo clínico dá acesso à consulta e à aprovação existentes; criação e alteração do catálogo continuam exigindo grants separados. |

Os testes focados, REDs, falhas de preparação e revisões estão identificados por hashes no JSON. O transporte das regressões de UI é simulado; as provas de contrato usam comandos e respostas nativos conforme seu escopo. A validação visual usa o navegador fixado da CI em servidores sintéticos isolados. Nenhum resultado sintético aprova referências clínicas reais.

A escolha de setor no cadastro de serviço depende da consulta autorizada de setores (`department.view`). A permissão de criação não concede essa leitura automaticamente. Os testes positivos declaram os dois acessos e o teste de negação verifica a ausência de opções e de POST; o servidor continua permitindo apenas os comandos e escopos concedidos.

## Validação desta candidata

A validação focada desta fonte passou: **317 testes clínicos**, **117 de catálogo/administração** e **36 de pendências de setores/contratos**, nos escopos registrados em cada prova. O navegador canônico passou em três repetições de Home e três casos visuais, com uma tentativa por caso, sem retries nem alteração das referências de imagem.

A [CI anterior](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38198443808) terminou com 11 checks SUCCESS, 5.332 testes unitários/PostgreSQL, 195 cenários principais de navegador e 48 cenários PostgreSQL. Esses números pertencem à fonte anterior. A nova candidata precisa de CI integral ligada ao SHA publicado no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78).

Também está preparado o build isolado de app, ops, MinIO e mc com revisão e fingerprint gravados, scan e CycloneDX por imagem. Na captura deste documento, esse build e seu smoke ainda não tinham sido executados. IDs de imagem locais não são digests de publicação em registry. Imagens anteriores com revisão `unknown` ou SBOM apenas de dependências não comprovam esses novos artefatos.

## Aceites pendentes

Os itens 021, 022, 035 e 040 conservam condições institucionais de conteúdo, contexto, procedimentos e indicadores. O 042 exige homologação do HIS instalado e identificação de LIS/PACS; o 050 exige a decisão específica sobre fornecedor, utilidade e dados antes da ativação. O 051 exige os ensaios e o aceite no alvo hospitalar. Implementação e teste técnico não encerram essas condições literais.

Você foi registrado como responsável pela validação dos fluxos e pelo aceite no [registro do piloto](../operations/HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json). O [pacote de UAT](../operations/HOSPITAL_PLANNER_PILOT.md) mantém fichas de cenários, resultados e assinatura. HIS informado: `cvg-his-v4` na VPS; LIS/PACS desconhecidos. Execução, assinatura e go/no-go continuam pendentes.

A revisão técnica suplementar usará uma rubrica congelada sobre o packet final. O PROD-605 exige revisão independente externa contratada, conforme o [plano](PRODUCTION_PLAN.md) e o [roadmap de produção](PRODUCTION_ROADMAP.md); uma nota de outro agente não substitui esse gate. Merge na main, publicação em registry e implantação não foram realizados nesta captura.
