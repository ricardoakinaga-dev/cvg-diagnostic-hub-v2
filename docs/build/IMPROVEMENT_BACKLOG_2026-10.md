# Backlog de melhorias e correções — CVG Diagnostics Hub

**Versão:** IMP-2026-10.1 · **Data:** 04/10/2026
**Fonte:** [auditoria de 04/10/2026](../RELATORIO_AUDITORIA_2026-10-04.md) + pedido do dono de um sistema mais dinâmico e com menos burocracia (referência de uso: Plane).
**Complementa** o [backlog até produção](PRODUCTION_BACKLOG.md) (PROD-*), que segue dono do caminho de go-live e das decisões D1–D12. Aqui ficam o que o PROD não cobre: correções da auditoria, UX e redução de processo.

[Roadmap](IMPROVEMENT_ROADMAP_2026-10.md) · [Auditoria](../RELATORIO_AUDITORIA_2026-10-04.md)

## Regras (curtas)

- **Status:** `READY` · `BLOCKED` (diz de quê) · `IN_PROGRESS` · `DONE` (com evidência). Nada vira `DONE` sem o aceite medido.
- **Prioridade:** `P0` antes do deploy · `P1` próxima onda · `P2` melhoria.
- **Tamanho:** `S` ≤ 3 dias · `M` 4–8 · `L` > 8.
- **Princípio de UX:** toda tela de uso diário se mede em **interações**. Segurança, auditoria e autorização ficam no servidor e não aparecem como campos. Motivo e senha só onde a regra clínica ou o risco exigem.

## 1. Correções (COR) — vêm da auditoria

| ID | Pri | Status | Tam. | Entrega e aceite | Origem |
| --- | --- | --- | --- | --- | --- |
| COR-01 | P0 | DONE | S | **Cutover 013/014 sem janela de erro.** (a) Procedimento "parar app/worker → backup → migrate → subir" no DEPLOYMENT §4.1 (feito). (b) O `migrate` recusa aplicar 013/014 se houver outra sessão conectada. Aceite: ensaio em PostgreSQL com a versão antiga ligada termina com recusa clara, sem escrita perdida; teste automatizado. **Feito em 05/10/2026:** `applyMigrations` + `tests/postgres/cutover-guard.integration.test.ts` (PostgreSQL real) + 4 testes unitários. | N-01 |
| COR-02 | P0 | READY | S | **Commit em fatias e CI remoto.** Dividir os 101 arquivos em commits revisáveis (endurecimento de produção; auditoria/outbox relacional; UX; dependências vendorizadas), push, CI verde. Aceite: link da execução com todos os jobs verdes (fecha PROD-001/002). | N-05 |
| COR-03 | P0 | DONE | S | **Pôr o E2E da UX no CI.** `tests/e2e/ux-simplification.spec.ts` entrou no job de browser (`--retries=0`). Aceite: job falha se qualquer meta de interações regredir. | N-02 |
| COR-04 | P1 | IN_PROGRESS | S | **Governar o `fast-glob` vendorizado.** O CI já confere hash e proveniência (`test:config`). Falta: o dono confirmar a D-026 e fixar o gatilho de revisão (proposto: todo upgrade de eslint/next, e 04/01/2027 no máximo); remover o vendor quando sair correção upstream do `braces`. Aceite: D-026 com `DECISION` e dono. | N-03 |
| COR-05 | P1 | DONE | S | **Teto de latência no benchmark.** `perf:postgres` reprova acima de p95 absoluto (2× as metas do PRD: 1.000 ms leitura, 1.600 ms busca/escrita; `PERF_POSTGRES_P95_CEILING_FACTOR`). Medido em 05/10/2026: leitura 126 ms, escrita 146 ms. A "piora de latência" citada na primeira versão da auditoria não se confirmou. O aceite com o volume de D2 segue no PROD-110. | N-04 |
| COR-06 | P2 | DONE | S | **Trocar `window.confirm`** por confirmação no padrão das demais telas (`useConfirm`, foco preso, Escape cancela, foco volta ao botão). Feito em revogar sessão, reprocessar/descartar dead-letter e gerar nova senha; testes de componente e E2E ajustados. | N-06 |

## 2. UX e dinâmica (UX) — o que falta para ficar como o Plane

Já entregue e medido (não reabrir): criar usuário em 4 interações, trocar setor em 2, liberar resultado em 1, board com quick add, painel lateral, Ctrl+K, aba Sistema, senha temporária com "Gerar nova senha".

| ID | Pri | Status | Tam. | Entrega e aceite | Depende |
| --- | --- | --- | --- | --- | --- |
| UX-01 | P1 | READY | M | **Minha fila e responsável no card.** Atribuir/assumir exame com 1 clique; filtro "só os meus". Aceite: assumir um exame = 1 interação; auditoria registra quem assumiu. | — |
| UX-02 | P1 | READY | M | **Filtros e visões salvas** no board (setor, prioridade, responsável, atraso de SLA), com agrupamento. Aceite: aplicar filtro salvo = 1 interação; visão persiste por usuário. | — |
| UX-03 | P1 | READY | M | **Entrada (triage) de solicitações novas:** aceitar ou rejeitar na própria fila; rejeição com motivo escolhido de lista. Aceite: aceitar = 1 clique; rejeitar = 2. | — |
| UX-04 | P1 | READY | M | **Configuração guiada do hospital** (primeiro uso): setores → exames → usuários em 3 passos, com padrões prontos. Aceite: um ADMIN novo deixa o sistema usável em ≤ 10 interações sem ler documentação. | — |
| UX-05 | P1 | BLOCKED | M | **Etapas do fluxo editáveis por setor** (nome, ordem, cor), mantendo fixas as travas clínicas (liberação, crítico, emenda). | D4, D7 |
| UX-06 | P2 | READY | M | **Ações em lote** no board: mover, atribuir ou priorizar vários exames de uma vez. Aceite: 5 exames movidos em ≤ 3 interações. | UX-01 |
| UX-07 | P2 | READY | S | **Importar usuários e exames por CSV**, com pré-visualização dos erros antes de aplicar. | — |
| UX-08 | P2 | READY | S | **Atalhos do board** (mover, assumir, abrir) e ajuda com `?`. | — |
| UX-09 | P2 | READY | S | **Notificações:** marcar tudo como lido e agrupar por exame. | — |
| UX-10 | P1 | BLOCKED | S | **Medir de verdade:** tempo e interações por tarefa com usuários do piloto, contra as metas acima; o resultado volta ao backlog. | PROD-703 |
| UX-11 | P2 | BLOCKED | M | **Troca de senha self-service** (exige a senha atual, revoga as outras sessões). Hoje só o ADMIN gera nova senha. | D1 (PROD-201) |

## 3. Menos burocracia (DOC)

| ID | Pri | Status | Tam. | Entrega e aceite |
| --- | --- | --- | --- | --- |
| DOC-01 | P1 | READY | M | **Consolidar `docs/build/`:** hoje são 30 arquivos de vários programas encerrados (AAA, state-of-art, frontend, 95, AUDIT). Mover os encerrados para `docs/archive/` com um índice e manter **um** roadmap e **um** backlog vivos. Ajustar o `validate-docs` para a nova estrutura. Aceite: `docs/build/` com ≤ 8 arquivos; `validate:docs` verde; links íntegros. |
| DOC-02 | P1 | READY | S | **Guia de uso de 1 página por perfil** (laboratório, imagem, gestor, admin), com prints. Substitui explicação em runbook. Aceite: página única por perfil, revisada por um usuário real. |
| DOC-03 | P1 | READY | S | **Tirar a evidência bruta do backlog.** O §9 do `PRODUCTION_BACKLOG.md` guarda páginas de resultado de teste por item. Mover para `docs/evidence/` e deixar no backlog uma linha por item com link. Aceite: backlog legível em uma tela por onda. |
| DOC-04 | P2 | READY | M | **Uma só fonte para os números** (testes, cobertura, OpenAPI, migrations): um `docs/build/STATUS.json` gerado pelos gates, e os documentos apontam para ele em vez de copiar. Aceite: `validate:docs` falha se algum doc citar número diferente do arquivo. |
| DOC-05 | P2 | READY | S | **Runbooks de no máximo 1 página** (`INCIDENT_RUNBOOKS.md`): sintoma → comando → quem chamar. Regra: nenhum runbook novo sem incidente real que o justifique. |

## 4. Técnico (TEC)

| ID | Pri | Status | Tam. | Entrega e aceite | Depende |
| --- | --- | --- | --- | --- | --- |
| TEC-01 | P0 | BLOCKED | XL | Cutover relacional da autoridade clínica e aposentadoria do snapshot (PROD-111). | D2, PROD-110 |
| TEC-02 | P2 | READY | M | Quebrar os maiores arquivos: `service-common.ts` (757 linhas), `clinical-core-adapter.ts` (734), `validate-openapi.mjs` (702). Aceite: nenhum acima de 600 sem justificativa; testes verdes, sem exceção de cobertura nova. | — |
| TEC-03 | P2 | READY | S | Reduzir as 22 exceções de cobertura declaradas, começando pelas de branches mais baixos (`clinical-core-adapter` 68%, `cutover` 69%). Aceite: número de exceções menor, nenhuma nova. | — |
| TEC-04 | P2 | READY | S | Alinhar o Node: `engines` fixa `>=22 <23` e desenvolvedores rodam 24. Escolher e documentar (suportar 24 ou travar a 22 no `.nvmrc` e no hook). | — |
| TEC-05 | P2 | READY | S | **Isolar os testes unitários do ambiente PostgreSQL.** Com `POSTGRES_TEST_ADMIN_URL` exportada, `postgres-store-coverage.test.ts` falha ("requires explicit authorization before initializing a missing runtime row"); só o `test:coverage` limpa as variáveis. Aceite: `npx vitest run` passa com ou sem as variáveis. | — |

## 5. Resumo

| Grupo | Itens | `DONE` | `IN_PROGRESS` | `READY` | `BLOCKED` |
| --- | ---: | ---: | ---: | ---: | ---: |
| COR | 6 | 4 | 1 | 1 | 0 |
| UX | 11 | 0 | 0 | 8 | 3 |
| DOC | 5 | 0 | 0 | 5 | 0 |
| TEC | 5 | 0 | 0 | 4 | 1 |
| **Total** | **27** | **4** | **1** | **18** | **4** |

Ordem de ataque: COR-01, COR-03, COR-05 e COR-06 estão feitos (05/10/2026); falta o COR-02 (push e CI remoto) e a confirmação do dono no COR-04 antes de qualquer deploy. Depois UX-01…04 e DOC-01…03 em paralelo, que são os que mais reduzem a fricção que o dono relatou.
