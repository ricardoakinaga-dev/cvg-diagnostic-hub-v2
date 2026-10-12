# Controle de mutações e nova rodada de CI do planner

> Captura histórica anterior às correções de UI e preparação PostgreSQL. A quarta CI passou verify e falhou nas jornadas PostgreSQL; ver o [registro posterior](HOSPITAL_PLANNER_BROWSER_POSTGRES_FOLLOWUP_2026-10-12.md). Os campos abaixo preservam a captura original.

**Data:** 12/10/2026 · **Estado na captura:** sete controles locais aprovados; CI global pendente do commit corretivo · **042:** PARTIAL · **051:** OPEN · **Release:** não aplicada.

O [registro estruturado](HOSPITAL_PLANNER_MUTATION_CI_FOLLOWUP_2026-10-12.json) e o [manifesto](HOSPITAL_PLANNER_MUTATION_CI_SOURCE_MANIFEST_2026-10-12.json) identificam **1088 arquivos**, fonte `c78ea159e0a7a2a04f4b2bcb0b9631a5d835e22b53e8f989e320641aeb2f0cd5`. A diferença contra `007b8c4` altera três inputs de validação e acrescenta 3 scripts; **1082 inputs anteriores continuam byte a byte idênticos**, incluindo o produto e os testes unitários/PostgreSQL/navegador existentes.

## Falhas anteriores e correção

A [primeira CI](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38188835705) falhou em quatro testes de indicadores dependentes da data; o [reparo do relógio](HOSPITAL_PLANNER_CI_FOLLOWUP_2026-10-12.md) conserva RED/GREEN em dois fusos.

A [segunda CI](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38190584294), no commit `007b8c4`, passou **5.305 testes em 361 arquivos**: 5.164 unitários e 141 PostgreSQL. Cobertura: linhas **98,41%**, statements **95,94%**, funções **97,17%** e branches **92,53%**; 20 exceções existentes, nenhuma nova ou obsoleta. O workflow falhou depois, porque `MC-AUTH-001` procurava um guard anterior às permissões efetivas de grupo. Imagem e navegador ficaram pulados. Esse G4 aprovado não torna a CI completa verde.

O mutante agora remove somente a checagem de papel em uma cópia temporária, preservando `active` e permissões efetivas. O guard real do produto permanece idêntico. O runner passa a exigir baseline verde e assertions de corpo reais para detectar os sete controles; falhas de hook, setup, runtime, processo, timeout ou coleta vazia não contam como detecção. A cópia usa inventário Git não ignorado, arquivos regulares permitidos e ambiente mínimo, excluindo dados, credenciais, ambientes reais, builds e symlinks de origem.

## Evidência local

| Controle | Categoria | Baseline | Mutante detectado |
| --- | --- | --- | --- |
| MC-AUTH-001 | authorization | 10 PASS | 1 assertions FAIL / exit 1 |
| MC-VERSION-001 | optimistic-version | 13 PASS | 3 assertions FAIL / exit 1 |
| MC-MIGRATION-001 | migration-integrity | 53 PASS | 1 assertions FAIL / exit 1 |
| MC-UPLOAD-001 | upload-boundary | 20 PASS | 1 assertions FAIL / exit 1 |
| MC-OUTBOX-001 | outbox-lease | 58 PASS | 1 assertions FAIL / exit 1 |
| MC-REALTIME-001 | realtime-replay | 38 PASS | 1 assertions FAIL / exit 1 |
| MC-RECOVERY-001 | recovery-integrity | 5 PASS | 1 assertions FAIL / exit 1 |

A primeira execução segura **FAIL 5/7** permanece no JSON: duas assertions nativas de `.rejects` tinham sido recusadas pelo classificador. As regressões do runner cobrem esse formato e falhas de preparação/execução com Vitest real; foram incluídas no `test:config`. A CI preserva logs e relatórios de cada baseline/mutante como artefatos. Revisão independente e checks documentais constam no registro.

## Publicação e aceite hospitalar

Esta captura antecede o commit corretivo. A identidade publicada, os sete checks completos e seus artefatos são conferidos no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78) e nos [Actions da branch](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions?query=branch%3Afeat%2Fhospital-planner-20261012). Nenhuma validação focada substitui essa rodada global.

O [roadmap](ROADMAP_HOSPITAL_PLANNER_2026-10-11.md), o [backlog](BACKLOG_HOSPITAL_PLANNER_2026-10-11.md) e o [pacote de piloto](../operations/HOSPITAL_PLANNER_PILOT.md) mantêm **042 PARTIAL, 051 OPEN e release não aplicada**. O hospital informou `cvg-his-v4` instalado na VPS; integração adotada, vínculos/endpoints aprovados, conteúdo clínico, ensaios no alvo e aceite nominal continuam pendentes. LIS/PACS permanecem desconhecidos. Serviços e dados hospitalares não foram alterados.
