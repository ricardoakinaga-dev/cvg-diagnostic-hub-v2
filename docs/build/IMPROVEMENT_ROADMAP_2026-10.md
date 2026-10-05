# Roadmap de melhorias e correções — CVG Diagnostics Hub

**Versão:** IMP-2026-10.1 · **Data:** 04/10/2026
**Knowledge status:** `DECISION` para a ordem e os critérios de saída; `ASSUMPTION` para os tamanhos (viram prazo só com a equipe definida).

[Backlog](IMPROVEMENT_BACKLOG_2026-10.md) · [Auditoria](../RELATORIO_AUDITORIA_2026-10-04.md) · [Roadmap até produção](PRODUCTION_ROADMAP.md)

## Como este roadmap se encaixa

O [roadmap até produção](PRODUCTION_ROADMAP.md) continua dono do caminho de go-live (M0–M6) e das decisões D1–D12. Este documento cobre três frentes que correm ao lado dele e não esperam decisão humana: **fechar os riscos da auditoria**, **tornar o sistema mais dinâmico para quem usa** e **cortar a burocracia de processo e de documentação**.

```
Onda A  Estabilizar ──► Onda B  Fluidez de uso ──► Onda C  Escala de uso
 (antes do deploy)       (em paralelo com C)        (depende de piloto e decisões)
 COR-01…03               UX-01…04, DOC-01…03        UX-05…11, DOC-04…05, TEC-*
```

## Onda A — Estabilizar (antes de qualquer deploy)

**Objetivo:** nenhum deploy derruba escrita, nenhuma regressão de UX passa batida, e o trabalho pendente vira histórico revisável.

| Entrega | Itens |
| --- | --- |
| Cutover 013/014 com procedimento e trava no `migrate` | COR-01 |
| 101 arquivos em commits revisáveis, push e CI remoto verde | COR-02 |
| E2E da UX no CI | COR-03 |
| `fast-glob` vendorizado sob controle (hash no CI, dono, revisão) | COR-04 |
| Teto de latência no benchmark e causa da piora | COR-05 |

**Estado em 05/10/2026:** COR-01 (trava do cutover), COR-03 (E2E da UX no CI), COR-05 (teto de p95) e COR-06 (diálogo de confirmação) estão `DONE`, com testes. Faltam o push com CI remoto verde (COR-02) e a confirmação do dono sobre o `fast-glob` vendorizado (COR-04).

**Critério de saída (todos):** CI remoto verde no commit candidato; ensaio de cutover com a versão antiga ligada recusado com clareza; `ux-simplification.spec.ts` rodando no CI; benchmark com teto de p95 ativo.

## Onda B — Fluidez de uso (o que o dono pediu)

**Objetivo:** o trabalho diário se resolve com poucas interações, sem tela de configuração para entender. Referência de comportamento: Plane (quick add, painel lateral, atalhos, visões, triage), com a segurança clínica por baixo.

| Entrega | Itens | Meta medida |
| --- | --- | --- |
| Assumir exame e "minha fila" | UX-01 | 1 interação |
| Filtros e visões salvas no board | UX-02 | 1 interação para reaplicar |
| Triage de solicitações novas | UX-03 | aceitar 1, rejeitar 2 |
| Configuração guiada do primeiro uso | UX-04 | ≤ 10 interações até o sistema ficar usável |
| `window.confirm` fora das telas (feito em 05/10/2026) | COR-06 | 0 diálogos nativos |
| Documentação enxuta: consolidar `docs/build/`, guia de 1 página por perfil, evidência fora do backlog | DOC-01…03 | `docs/build/` ≤ 8 arquivos |

**Critério de saída:** metas acima medidas em E2E; um usuário de cada perfil conclui suas tarefas principais sem ajuda, usando só o guia de 1 página.

## Onda C — Escala de uso (depende de piloto e decisões)

| Entrega | Itens | Depende |
| --- | --- | --- |
| Ações em lote, importação CSV, atalhos, notificações | UX-06…09 | Onda B |
| Etapas do fluxo editáveis por setor | UX-05 | D4, D7 |
| Medição de usabilidade com usuários reais | UX-10 | piloto (PROD-703) |
| Troca de senha self-service | UX-11 | D1 |
| Uma só fonte para os números dos docs | DOC-04 | DOC-01 |
| Reduzir arquivos grandes e exceções de cobertura; alinhar Node | TEC-02…04 | — |
| Cutover relacional definitivo | TEC-01 (= PROD-111) | D2, PROD-110 |

**Critério de saída:** tempos e interações do piloto dentro das metas, ou o backlog reaberto com o que medimos.

## Riscos e dependências

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| Deploy da versão com 013/014 sem parar a versão antiga | escritas clínicas falham na janela | COR-01 |
| Mais telas e atalhos sem medir | a burocracia volta por outro caminho | toda entrega de UX tem meta de interações no E2E e UX-10 mede com usuários |
| Mudança de UX remove proteção do servidor | risco clínico ou de segurança | regra do backlog: autorização, CSRF, auditoria e reautenticação de ADMIN continuam testadas no servidor |
| D1–D12 sem resposta | Onda C parada em UX-05 e UX-11 | seguem no [plano até produção](PRODUCTION_PLAN.md) |

## Regra para este roadmap

Não criar documento novo de plano para uma entrega. A entrega entra como item no backlog, ganha uma meta medida e uma linha de evidência. Documento novo só com decisão registrada em [DECISION_LOG](../DECISION_LOG.md).
