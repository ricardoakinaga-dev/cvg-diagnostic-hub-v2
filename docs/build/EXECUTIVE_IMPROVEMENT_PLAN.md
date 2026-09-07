# Plano executivo de melhorias — State of Art / AAA

> **Histórico AAA-1:** substituído para planejamento corrente pelo [programa AAA-2](AAA_2_EXECUTIVE_PLAN.md), em 05/09/2026, com base na [nova auditoria](../RELATORIO_AUDITORIA_2026-09-05.md). Conteúdo e estados abaixo preservados como registro anterior; não representam evidência atual.

**Versão:** `AAA-1`  
**Status:** `IN PROGRESS`  
**Base:** [relatório de status](../PROJECT_STATUS_REPORT.md) e [barra AAA](STATE_OF_ART_QUALITY_BAR.md).

## Resultado que será entregue

Transformar o MVP local atual em uma plataforma operacional verificável e preparada para validação clínica, sem inventar políticas do hospital nem mascarar limites de ambiente. O programa termina somente quando o código, os contratos, a persistência, a operação, a UX e a evidência estiverem coerentes no mesmo commit.

## Diagnóstico de partida

| Sinal | Atual | Alvo AAA |
| --- | ---: | ---: |
| Maturidade técnica local | 78/100 | ≥95 em cada dimensão local |
| Qualidade documental | 84/100 | ≥95 de coerência/frescor |
| Testes Vitest | 299 / 49 arquivos | todos verdes no primeiro passe |
| Cobertura configurada | 96,08% lines/statements; 84,04% branches; 97,19% functions | ≥80% com exclusões justificadas e UI crítica coberta |
| OpenAPI | 64 operações / 59 paths | paridade total com runtime |
| PostgreSQL | harness coleta 6 testes e integração coleta 10; execução real bloqueada por opt-in/banco ausente | suíte real em CI-equivalente e browser contra banco |
| Browser | verificação independente 45/45 sem retry com `--fail-on-flaky-tests` | primeira execução 100% limpa em CI remoto e browser PostgreSQL |
| Produção | `NOT READY` | somente após gates externos assinados |

## Frentes executivas

| Frente | Responsabilidade | Resultado esperado |
| --- | --- | --- |
| F0 — Verdade e controle | corrigir evidência, lockfile, configuração de testes e estado | decisão confiável no commit atual |
| F1 — Dados duráveis | schema relacional, migrations, constraints, transações, restore | integridade clínica demonstrada em PostgreSQL |
| F2 — Segurança e confiança | identidade, escopo, supply chain, upload, rate limit, auditoria | ausência de bypass local e fronteiras produtivas explícitas |
| F3 — Produto clínico | Patient Workspace, identidade, amostra, Lab, RX/US, resultados e criticidade | journeys completas com contexto inequívoco |
| F4 — Operação | outbox distribuído, realtime, observabilidade, performance e resiliência | falhas detectáveis, recuperáveis e medidas |
| F5 — Experiência | responsividade, teclado, leitor de tela, estados de erro e aceitação manual | uso eficiente e acessível nas três superfícies |
| F6 — Governança e release | documentação, matriz, CI, restore, piloto e gates humanos | release packet auditável e autorizado |

## Ordem de execução

1. **F0 primeiro:** fechar os bloqueios que invalidam qualquer evidência posterior.
2. **F1 e F2 em paralelo somente onde os arquivos e contratos forem disjuntos:** persistência não espera uma decisão cosmética; segurança não altera schema sem contrato.
3. **F3 depois de F1:** o Patient Workspace e os fluxos clínicos devem nascer sobre contexto e persistência duráveis.
4. **F4 e F5 sobre jornadas reais:** performance e UX serão medidas na fronteira servida, não apenas em funções isoladas.
5. **F6 por último e continuamente:** cada onda atualiza matriz, release checklist e evidência; o gate final é independente dos builders.

## Primeira onda executada; próxima onda em revisão

Esta onda tem quatro lanes disjuntas:

- **Lane A — testes/CI:** alias PostgreSQL, cobertura do harness e paridade de configuração. Dono: `vitest.postgres.config.ts` e `tests/postgres/**`.
- **Lane B — supply chain:** remediação de `fast-uri` e auditoria do lockfile. Dono: `package.json` e `package-lock.json`.
- **Lane C — browser reliability:** isolamento de estado/rate limit e primeiro passe E2E limpo. Dono: `playwright.config.ts` e `tests/e2e/**`.
- **Lane D — documentação:** frescor das métricas, remote V1, estado e ligação da nova barra. Dono: `docs/**`, exceto os quatro artefatos AAA criados pelo Lead.

O Lead mantém a integração, a barra, as interfaces compartilhadas e a verificação final. A onda produziu evidência local, mas continua em `REVIEW` até a crítica fresca. Nenhuma lane pode alterar `.gauntlet/`, migrations clínicas, segredos, infraestrutura externa ou critérios de aceitação sem nova decisão registrada.

## Riscos de execução

- A falta de PostgreSQL/Docker neste host é evidência ausente, não aprovação; a correção da configuração será validada localmente e a execução real continuará dependente de CI-equivalente.
- Atualização de dependência pode alterar schemas gerados; Redocly, drift e suíte de contratos são regressão obrigatória.
- Rate limit de teste não pode ser desabilitado para obter verde; deve ser isolado com configuração determinística e compatível com o comportamento produtivo.
- Migração relacional é R3: exige banco descartável, plano reversível e não será aplicada em ambiente externo.
- Política clínica e autorização hospitalar exigem owner humano; código pode falhar fechado, mas não pode escolher thresholds, destinatários ou SLA.

## Métrica de decisão

Ao fim de cada onda, atualizar as notas do [relatório de status](../PROJECT_STATUS_REPORT.md) usando evidência nova. A nota só sobe quando o gap que a limita for realmente eliminado; uma média alta nunca fecha um `AAA-*` obrigatório ausente.
