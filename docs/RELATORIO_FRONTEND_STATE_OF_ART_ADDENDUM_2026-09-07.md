# Addendum de direção frontend — AAA-3 corrente

**Data:** 07/09/2026  
**Documento-base:** [`RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md`](RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md)  
**Status:** atualização corrente; não substitui o parecer manual de UX, acessibilidade ou aceite hospitalar.

## 1. Por que este addendum existe

O relatório-base foi produzido em modo audit-only e registrou uma fotografia
anterior ao ciclo de hardening AAA-3. Este documento separa os deltas já
implementados e verificados dos achados que continuam abertos. O relatório-base
continua válido como diagnóstico histórico; números e renders antigos não são
tratados como evidência corrente.

## 2. Deltas locais fechados ou revalidados

| Achado-base | Estado corrente | Evidência |
| --- | --- | --- |
| F-01/F-14 — baseline visual e números divergentes | **Reconciliado localmente** | O manifesto AAA-3 corrente fixa o candidato, timestamp, fingerprint, 725/725 testes e cobertura 92,72/85,82/94,31; a matriz browser corrente passou 60/60 sem retry e o packet visual corrente contém 20 PNGs com hashes. |
| F-03 — rail mobile estreito | **Implementado localmente** | O `AppShell` possui `mobile-nav` responsiva, o rail lateral é removido em telas móveis e o conteúdo reserva espaço inferior seguro; a matriz browser inclui Chromium/tablet/mobile. |
| F-05 — primitives compartilhados insuficientes | **Parcialmente fechado** | `Surface`, `SectionHeading`, `ActionButton`, `Icon` e estados `Loading/Empty/Error/Partial/Stale` existem no código compartilhado. Nesta rodada, gatilhos de workflow e ações de retry/empty passaram a usar `ActionButton`. A cobertura manual de todos os primitives ainda não é alegada. |
| F-15 — alvos compactos | **Hardening local aplicado** | A folha global mantém piso de 44px para workflow, realtime, recovery, tabs, feedback e contexto de fila; os focais UI e a matriz browser precisam continuar sendo executados após mudanças de estilo. |
| F-17 — feedback/frescor desigual | **Fechado localmente; aceite semântico aberto** | O Patient Workspace preserva snapshot stale/partial/degraded, a confirmação de notificação permanece pendente até reconciliação, workflow isola pending de submit/release e filtros de notificação descartam respostas fora de ordem e callbacks stale. Códigos clínicos, policy e mensagens finais ainda dependem de revisão semântica. |
| F-18 — atalho e busca sem contrato de interação | **Fechado localmente** | O dashboard agora implementa Meta/Ctrl+K, foco e seleção do campo, combobox/listbox ARIA, ↑/↓, Enter, Escape, anúncio de contagem e descarte de respostas fora de ordem; o comportamento está coberto por teste de componente. |
| F-19 — leituras concorrentes e ações assíncronas inconsistentes | **Fechado localmente; aceite manual aberto** | RequestDetail, PatientList, Indicadores, Gestão, Administração, Fila, Patient Workspace e ResultView invalidam respostas obsoletas e usam estados `pending` por ação; regressões de rota/busca e a matriz browser 60/60 permanecem locais. |
| F-20 — contraste do breadcrumb administrativo | **Fechado localmente; aceite manual aberto** | O seletor `.breadcrumb .breadcrumb-product` deixou de ser sobrescrito pela regra genérica `.breadcrumb span`; Axe confirmou ausência de `color-contrast` nas 12 verificações administrativas, de gestão e clínicas em Chromium/tablet/mobile. |

## 3. Verificação corrente

- Node 22.23.2 / Next.js 16.3.0;
- `ActionButton`, workflow, feedback primitives e busca do dashboard: regressões focadas verdes;
- validação AAA-3 corrente: 725/725 testes, cobertura 92,72% linhas,
  85,82% branches e 94,31% funções;
- matriz browser corrente: 60/60 sem retry em Chromium/tablet/mobile, registrada
  em [`browser-e2e-node22-accessibility-20260907.md`](../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md);
- packet visual corrente: 20 PNGs re-capturados e verificados em
  [`sha256-manifest.json`](../.orchestrate/evidence/visual-patient-workspace-20260907/sha256-manifest.json);
- `release_claim` permanece `false`.

Essa execução completa foi promovida para o packet corrente após a rodada de
hardening de concorrência; a promoção não substitui revisão visual/manual.

## 4. Gaps que continuam reais

1. Fontes, tokens e temas ainda não têm contrato completo de asset/proveniência.
2. Identidade de paciente, ownership, homônimos, estados clínicos críticos e
   SLA continuam dependentes de D-01–D-04.
3. Acessibilidade manual de leitor de tela, teclado, touch, zoom e reduced motion
   ainda não foi assinada por avaliador independente.
4. Não há golden visual de produto aprovado por owner nem aceite hospitalar.
5. O layout e as mensagens precisam ser reavaliados em ambiente-alvo e com
   dispositivos assistivos acordados.

O bar visual AAA só poderá ser promovido quando os renders correntes, a revisão
manual e a autoridade clínica/hospitalar forem observados e registrados; nenhum
score automatizado substitui esses gates.
