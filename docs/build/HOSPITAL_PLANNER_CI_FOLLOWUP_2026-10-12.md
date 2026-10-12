# Revisão da CI do planner hospitalar

**Data:** 12/10/2026 · **Estado:** primeira CI falhou; relógio dos testes corrigido e provas focadas aprovadas; nova CI pendente da publicação · **042:** PARTIAL · **051:** OPEN · **Release:** não aplicada.

O [registro estruturado](HOSPITAL_PLANNER_CI_FOLLOWUP_2026-10-12.json) e o [manifesto corrente](HOSPITAL_PLANNER_CI_SOURCE_MANIFEST_2026-10-12.json) identificam 1.085 arquivos, fonte `cfb5ce999bc6b7bbdd3c6ba0753e4989767d3e103d44118b0e66fe06e2efb7b8`. A [correção HIS anterior](HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.md) mantém suas provas focadas nos inputs que continuam idênticos. Os resultados completos de 11/10 continuam históricos.

## Falha observada e reparo

`FACT` — A [primeira CI do PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38188835705), no commit `5111a50`, executou 5.164 testes unitários: **5.160 PASS / 4 FAIL**, em 327 arquivos, em 732,60 segundos. Os quatro casos de indicadores e relatórios fixavam a janela em 11/10, mas criavam parte das tarefas e aceites de passagem com o relógio real de 12/10. O produto excluiu corretamente fatos fora da janela. A etapa PostgreSQL e o gate final de cobertura não chegaram a executar.

O teste agora fixa somente `Date` em `2026-10-11T10:00:00Z` e restaura o relógio após cada caso. `setTimeout` e `setInterval` continuam reais; todas as assertions e os demais bytes originais foram preservados. RED reproduziu **7 PASS / 4 FAIL**; GREEN passou **11/11 em UTC** e **11/11 em Pacific/Honolulu**. Tipos e lint focados passaram. Código de produto, DTOs, permissões e definição de janela permanecem idênticos.

`DECISION` — O job verify passa de 25 para 40 minutos, para comportar os 12m13s observados na fase unitária, mais PostgreSQL, checks restantes e build. Os comandos, critérios, mínimos de cobertura e gates continuam os mesmos. A verificação do workflow passou.

## Fonte, publicação e resultados completos

A diferença contra a primeira candidata de 12/10 é de **dois arquivos de validação**, com **1.083 inputs restantes byte a byte idênticos**. Esta captura é anterior ao commit corretivo. A identidade do novo commit e os checks completos são conferidos no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78) e nos [Actions da branch](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions?query=branch%3Afeat%2Fhospital-planner-20261012).

CodeQL, revisão de dependências e benchmark PostgreSQL/SSE passaram na primeira CI. O agregado de navegador falhou porque seus projetos dependentes foram pulados; navegador, PostgreSQL de navegador e imagem não executaram. As falhas e limites permanecem no JSON; uma prova focada não transforma essa primeira CI em aprovação global.

## Homologação pendente

**042 PARTIAL, 051 OPEN e release não aplicada** permanecem. O [pacote de piloto](../operations/HOSPITAL_PLANNER_PILOT.md) exige conteúdo e fluxos reais, endpoints/vínculos aprovados, carga, restore, alertas e aceite nominal. O HIS instalado não foi alterado; LIS/PACS continuam desconhecidos.
