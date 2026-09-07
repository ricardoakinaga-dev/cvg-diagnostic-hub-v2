# Roadmap State of Art / AAA

> **Histórico AAA-1:** substituído para planejamento corrente pelo [programa AAA-2](AAA_2_ROADMAP.md), em 05/09/2026, com base na [nova auditoria](../RELATORIO_AUDITORIA_2026-09-05.md). Conteúdo e estados abaixo preservados como registro anterior; não representam evidência atual.

**Barra:** [`STATE_OF_ART_QUALITY_BAR.md`](STATE_OF_ART_QUALITY_BAR.md)  
**Plano:** [`EXECUTIVE_IMPROVEMENT_PLAN.md`](EXECUTIVE_IMPROVEMENT_PLAN.md)  
**Status atual:** `WAVE-0 REVIEW / WAVE-1 IN PROGRESS — gates externos preservados`

O roadmap usa gates de saída, não datas artificiais. Uma onda só avança quando a evidência da anterior é atual, o artifact fingerprint mudou de forma esperada e nenhum critério crítico da onda ficou sem prova.

| Onda | Escopo | Dependências | Saída obrigatória | Estado |
| --- | --- | --- | --- | --- |
| W0 — Verdade operacional | corrigir alias PostgreSQL, dependency HIGH, flake E2E, métricas e ledgers | relatório AAA e contratos congelados | `test:postgres` coleta, `npm audit` limpo, primeiro E2E limpo, docs alinhadas | REVIEW — local complete |
| W1 — Persistência durável | entidades clínicas relacionais, constraints, migrations, dual-read/backfill controlado, rollback | W0 + modelo de domínio aprovado | schema review, migration/rollback, concorrência e reload em PostgreSQL | IN PROGRESS — static expand-only core |
| W2 — Segurança institucional | IdP adapter, ownership, delegated manager, rate limit distribuído, storage/AV, sessão multi-instância | W1 + políticas humanas mínimas | matriz allow/deny, sessão cross-instance, upload seguro e configuração produtiva fail-closed | PENDING |
| W3 — Patient Workspace | contexto paciente/encounter/admission, homônimos, amostra/accession, transferência/alta | W1/W2 + decisões clínicas | jornada servida de contexto → request → resultado, reload, autorização e auditoria | PENDING |
| W4 — Verticais clínicas | Lab com authoring/catalog aprovado, RX, US, recolleta, resultados e critical workflow | W3 + políticas clínicas | journeys reais por modalidade, sem mocks de mutação, estados e fallbacks aprovados | PENDING |
| W5 — Operação distribuída | outbox worker/broker, SSE fanout, readiness, métricas, alertas, incidentes, perf | W1–W4 | multi-instância, carga representativa, p95/p99, chaos/failure drill e runbooks | PENDING |
| W6 — UX AAA | inspeção visual/manual, leitor de tela, touch, estados degraded/offline, treinamento | W3–W5 | aceite manual, screenshots/recordings versionados e zero regressão axe/keyboard | PENDING |
| W7 — Recuperação e release | backup PostgreSQL + anexos + chaves, restore, CI remoto, rollback, pilot packet | W1–W6 + owners | restore dentro de RPO/RTO, CI verde, release checklist assinado | PENDING |
| W8 — Governança hospitalar | policies, IdP, residency, retention, clinical pilot e support ownership | W7 + autoridade externa | `AAA-21`/`AAA-22` fora de `BLOCKED EXTERNAL` com evidência I3 | BLOCKED EXTERNAL |

## Caminho crítico

```text
W0
 ├── W1 Persistência ── W2 Segurança institucional ── W3 Patient Workspace
 │                                                   └── W4 Verticais clínicas
 └── W0 Browser/Docs ──────────────────────────────── W5 Operação distribuída
                                                        └── W6 UX AAA
                                                             └── W7 Release
                                                                  └── W8 Governança
```

## Gates de transição

- **W0 → W1:** não há falha local determinística conhecida em testes, dependências ou contratos; a execução PostgreSQL permanece bloqueada pelo ambiente.
- **W1 → W2/W3:** PostgreSQL é fonte verificável para os invariantes clínicos e há recuperação testada.
- **W2 → W3:** autorização institucional tem owner e casos negativos; nenhuma permissão é inferida da UI.
- **W3 → W4:** contexto clínico acompanha o request, item, sample, result e timeline em reload e concorrência.
- **W4 → W5:** cada modalidade tem seu caminho, lifecycle, erro e audit trail próprios.
- **W5 → W6:** falhas operacionais são observáveis e a latência é conhecida sob workload representativo.
- **W6 → W7:** aceite manual e acessibilidade não têm achado bloqueante.
- **W7 → W8:** release packet local está completo; só faltam as decisões e validações externas declaradas.
