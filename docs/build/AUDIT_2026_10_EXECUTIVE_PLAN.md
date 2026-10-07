# Plano Executivo Pós-Auditoria — CVG Diagnostics Hub

**Versão:** AUDIT-2026-10
**Data:** 01/10/2026
**Estado:** EXECUÇÃO LOCAL CONCLUÍDA COM CONDIÇÕES / NÃO PRONTO
**Autoridade:** patrocinador, engenharia, segurança, produto, UX e SRE

Documentos relacionados:

- [Relatório de auditoria de 01/10/2026](../RELATORIO_AUDITORIA_2026-10-01.md)
- [Roadmap AUDIT-2026-10](AUDIT_2026_10_ROADMAP.md)
- [Backlog AUDIT-2026-10](AUDIT_2026_10_BACKLOG.md)
- [Programa AAA-3 vigente](STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md)
- [Matriz de rastreabilidade](../TRACEABILITY_MATRIX.md)

## 1. Decisão executiva

Fechar, em onda dedicada e verificável, as falhas levantadas pela auditoria de 01/10/2026, sem expandir escopo clínico e sem retirar o programa AAA-3 do estado `BLOCKED` — esta onda remove dívida técnica comprovada e prepara o terreno para a re-auditoria, não autoriza produção nem piloto.

O relatório atribuiu **76/100** globais. A ordem de investimento é:

1. corrigir os gates de garantia que hoje falham de forma falsa (scan de segredos e validador de documentação);
2. eliminar a exposição de segurança crítica (dependências com RCE, chave de rate limit, HSTS, timing de login);
3. tornar a falha observável (log de 500, migration no `/readyz`, alertas);
4. medir o que importa (cobertura da persistência, gate por arquivo, inspeção manual de acessibilidade);
5. construir o caminho de operação que não existe (imagem, deploy, supply chain, RPO/RTO);
6. re-auditar de forma independente e só então reapresentar o candidato.

## 2. Estado confirmado no snapshot inicial

Medido nesta auditoria sobre `main` @ `6ab4735` (`FACT`):

| Dimensão | Nota |
| --- | ---: |
| Arquitetura e qualidade de código | 82 |
| Testes e CI/CD | 84 |
| Segurança | 74 |
| Documentação | 85 |
| UX / Frontend | 74 |
| Operações e Production Readiness | 57 |
| Higiene do repositório e DevOps | 52 |
| Processo, evidência e honestidade | 80 |
| **Global ponderado** | **76** |

Reproduzido com EXIT=0: typecheck, lint, 725/725 testes (86 arquivos), cobertura 92,72/85,79/94,37, rastreabilidade 43/43 e OpenAPI 65/60. Reproduzido com falha: `npm audit` (1 critical, 1 high), `validate-docs.sh` (falso positivo por ausência de `rg`) e `secret-scan.sh` (falso negativo — aprova sem escanear).

Nada deste levantamento altera os 45 gates abertos de `PRODUCTION_READINESS.md`, `RELEASE_CHECKLIST.md` e `OPEN_QUESTIONS.md`.

## 2.1 Estado corrente da onda — 02/10/2026

O backlog corrente mantém os itens DONE/BLOCKED definidos no backlog; a candidata
de 02/10 passou **768/768 testes locais em 91 arquivos**. A execução unitária
registrou 92,79% lines, 86,12% branches e 94,23% functions. A cobertura agregada
PostgreSQL passou 809/809 testes em 98 arquivos, com 94,98% lines, 89,09% branches
e 95,30% functions; o coverage gate passou com 29 exceções temporárias sem arquivos
uncovered/stale. Migrations, docs, security scan, typecheck, lint, build, E2E 63/63
sem retry, mutation 7/7, traceabilidade 43/43 e OpenAPI 70/65 passaram.
Esses números atualizam apenas a evidência local e não reclassificam a nota
histórica de 76/100 nem os gates humanos.

## 3. Resultado contratado

Ao final desta onda, o repositório deverá permitir afirmar, com evidência reproduzível:

- `npm audit --audit-level=high` sem vulnerabilidades críticas ou altas em produção;
- `security:scan` e `validate:docs` falhando de forma honesta quando a ferramenta ou o conteúdo estiverem errados, em qualquer ambiente;
- toda falha 500 correlacionável no servidor e `/readyz` refletindo a compatibilidade real de migration;
- camada de persistência medida por cobertura, com gate por arquivo e sem arquivo crítico abaixo de 80%;
- alvos de interação e semântica de status uniformes em toda a interface, com inspeção manual registrada;
- caminho de build e deploy de imagem versionada, com revisão automática de dependências;
- número único e reconciliado por documento para cada métrica citada;
- re-auditoria independente com nota mínima de 85 e nenhum achado crítico ou alto aberto.

## 4. Escopo e não-escopo

**Em escopo:**

- os 40 itens do [backlog AUDIT-2026-10](AUDIT_2026_10_BACKLOG.md), agrupados nas seis fases do [roadmap](AUDIT_2026_10_ROADMAP.md);
- reconciliação numérica dos documentos de planejamento e testes;
- atualização dos documentos de segurança para refletir a implementação real.

**Fora de escopo:**

- decisões clínicas D-01 a D-04 e de governança D-05/D-06 do programa AAA-3;
- cutover relacional, Patient Workspace completo, módulos `apps/web`/`apps/api`;
- qualquer mudança de escopo de produto, novas funcionalidades clínicas ou alteração de contratos públicos além do que a segurança exigir;
- qualquer declaração de prontidão produtiva ou clínica.

## 5. Princípios de execução

1. **Um número, uma fonte.** Toda métrica citada em documento aponta para comando, ambiente, data e limitação.
2. **Gate honesto antes de gate verde.** Nenhum script de garantia pode aprovar silenciosamente quando sua dependência falta.
3. **Correção por prova.** Item só vira `DONE` com evidência nova e reproduzível; packet histórico não fecha item.
4. **Zero regressão.** A candidata corrente preserva 768/768 testes locais; a suíte PostgreSQL 41/41 e os gates de cobertura agregada foram repetidos com ambiente descartável.
5. **Evidência local é local.** A onda não altera o estado `CONDITIONAL PASS / BLOCKED` do candidato.

## 6. Critérios de aceite globais

| # | Critério | Prova |
| --- | --- | --- |
| G-1 | Auditoria de dependências sem critical/high | `npm audit --audit-level=high` exit 0 em CI |
| G-2 | Gates de garantia honestos | `security:scan` e `validate:docs` exit 1 na injeção de falha proposital (ferramenta ausente e conteúdo removido) |
| G-3 | Falha 500 observável | teste que injeta exceção e afirma correlação logada sem vazar stack ao cliente |
| G-4 | Persistência medida | `test:postgres` no denominador de cobertura; `postgres-store.ts` ≥ 80% lines |
| G-5 | Gate por arquivo ativo | zero arquivos de produto abaixo de 90/85 sem exceção registrada e justificada |
| G-6 | Acessibilidade consistente | axe ampliado aprovado fora de `main`, alvos ≥ 44 px e inspeção manual anexada |
| G-7 | Caminho de operação | imagem buildada, pipeline com revisão de dependências e RPO/RTO decidido por autoridade |
| G-8 | Re-auditoria | relatório independente fresco com nota ≥ 85 e zero achado crítico/alto aberto |

## 7. Riscos da onda

| Risco | Impacto | Tratamento |
| --- | --- | --- |
| Atualização do Next quebra comportamento de proxy ou CSP | Alto | Executar matriz browser completa antes e depois; manter `proxyClientMaxBodySize` explícito |
| Cobertura da integração PostgreSQL exige cluster descartável indisponível na máquina | Médio | Gate de fase usa host com `initdb`/Docker; sem cluster, item fica `BLOCKED` documentado, não `DONE` |
| Decisão de RPO/RTO e secret manager dependem de autoridade externa | Alto | Itens `BLOCKED` com dono nomeado; não atrasam as fases independentes |
| Volume de correções compete com o programa AAA-3 | Médio | Backlog AUDIT é a fonte desta onda; itens AAA-3 permanecem com seus próprios IDs e status |
| Re-auditoria independente indisponível | Médio | Agendar na abertura da fase G5, não no fim |

## 8. Governança

| Papel | Responsabilidade na onda |
| --- | --- |
| Engenharia | Fases G0–G3 e G5; evidência por item |
| Segurança | Priorização e aceite de G1; revisão dos docs de segurança |
| SRE/Operação | Fase G4; decisão de RPO/RTO com a autoridade do hospital |
| Produto | Reconciliação numérica e escopo de não-escopo |
| UX | Fase G3; inspeção manual de acessibilidade |
| Patrocinador | Liberação de dependências externas e agendamento da re-auditoria |

Nenhum gate de fase é aceito sem registro no backlog com status, dono, evidência e próxima ação explícitos.
