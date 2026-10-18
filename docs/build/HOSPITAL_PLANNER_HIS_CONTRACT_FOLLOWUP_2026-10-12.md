# Compatibilidade HIS e preparação da revisão hospitalar

**Data:** 12/10/2026 · **Estado local:** correção HIS e contrato Unicode com provas focadas aprovadas; CI completa a consultar no GitHub · **042:** PARTIAL · **051:** OPEN · **Release:** não aplicada.

**Revisão posterior da CI:** consultar o [registro corrente](HOSPITAL_PLANNER_CI_FOLLOWUP_2026-10-12.md) e o [manifesto](HOSPITAL_PLANNER_CI_SOURCE_MANIFEST_2026-10-12.json). Esta captura conserva as provas do reparo HIS na fonte original; o novo ajuste afeta somente testes e duração da CI.

Este é o registro do reparo HIS posterior ao [snapshot de 11/10](HOSPITAL_PLANNER_VALIDATION_2026-10-11.json). A [evidência estruturada](HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.json) e o [manifesto de 1.085 arquivos](HOSPITAL_PLANNER_SOURCE_MANIFEST_2026-10-12.json) identificam a fonte `fbf9a702b9d2b6fd9808ad334d09cfda01fc1a84444b71fdb23316e09493bab5`. Os resultados completos anteriores continuam atribuídos às fontes em que foram executados.

## Defeito e correção

`FACT` — Nas revisões HIS `0ebfc5b6627c8ed006075dc5285fd3514443c806` e `272581dc60b764a8fee78108110dc7e465f62542`, a cadeia callback → EventBus → consumer → webhook acrescenta `data._meta`. O schema estrito do Hub recusava esse objeto com `HIS_V4_EVENT_NOT_ADOPTED`, embora os testes anteriores usassem uma fixture sem metadata. A nova reprodução preserva três falhas antes da correção.

O ingresso agora aceita a metadata conhecida e limitada: versão `1`, conta coerente, identificadores técnicos e extras declarados. Campos de negócio e metadata permanecem estritos. Assinatura do corpo bruto, identidade da entrega, hash completo, credencial, ator e vínculos nativos permanecem com suas autoridades anteriores. A demanda contém somente os campos mapeados; o recibo continua sendo recebimento para triagem.

O OpenAPI declara os identificadores técnicos com limite de 255 pontos de código Unicode e padrão de conteúdo não vazio. Isso evita depender da flag `u` que o exportador de regex não preserva. A regra de tamanho está descrita no [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.3.1). O contrato continua com **248 operações em 209 caminhos**.

## Provas locais

| Verificação | Resultado e limite |
| --- | --- |
| Produtor/HMAC/serviço/rota HIS | **40/40**, em quatro arquivos; 20 fragmentos de nove fontes pinadas executados com repositórios e transporte sintéticos. RED e execuções intermediárias foram preservados. |
| Contrato OpenAPI | **19/19**; regressão Unicode RED → GREEN, mais lint e comparação semântica do contrato. |
| Catálogo HTTPS | Servidor nativo `createApiServer` HIS em test/memory, cliente HTTPS real do Hub e CA efêmera: **200/401/403/401** para chave válida, inválida, escopo insuficiente e chave desativada. 498 fontes carregadas verificadas; porta dinâmica fechada e PEMs removidos. |
| Fonte do catálogo | O ensaio usou um snapshot do módulo de schema anterior; cliente, configuração e declaração do catálogo permanecem byte a byte iguais. Essa qualificação não transforma o ensaio em reexecução do módulo corrente inteiro. |
| Formatação | Cinco bytes LF finais removidos com JavaScript emitido idêntico. CSVs preservados; atributos em três caminhos reconhecem CRLF e mantêm as verificações de whitespace. |

Tipos, lint do projeto e checks finais de documentação/privacidade são registrados no JSON, com comandos, saídas e digests. O manifesto registra a diferença real de **11 arquivos alterados e três novos** contra `bf1e660…`; essa correção inclui produto e especificação.

## Commit e CI

`DECISION` — Preparar a branch `feat/hospital-planner-20261012` e PR em rascunho contra `main`. A identidade do commit e os checks completos são autoridades do GitHub; consultar [Actions da branch](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions?query=branch%3Afeat%2Fhospital-planner-20261012). Este documento e seu JSON foram capturados antes da publicação. Não declaram CI completa executada localmente após a mudança de produto.

Os **5.283 testes G4**, as imagens medidas e os **195 cenários de navegador compostos** de 11/10 continuam históricos nas fontes `673bc9…/bf1e660…`. Eles não certificam automaticamente esta nova fonte. Os avisos de aplicabilidade nos registros anteriores preservam seus resultados, falhas, auditorias literais e classificações.

## Pendências institucionais

`OPEN QUESTION` — A origem das imagens HIS instaladas continua desconhecida; a fonte pinada e o sandbox em memória não homologam essas imagens. Permanecem necessários receptor HTTPS aprovado, vínculos/credenciais e mapeamentos reais, conteúdo clínico, volume alvo, scanner, restore e alertas no alvo, jornadas com usuários e aceite nominal. LIS/PACS continuam desconhecidos. Usar o [pacote de piloto](../operations/HOSPITAL_PLANNER_PILOT.md) para registrar decisões, resultados e assinaturas. **042 PARTIAL, 051 OPEN e nenhuma entrega marcada DONE** permanecem.
