# Roadmap frontend AAA³

## CVG Diagnostic Hub — ondas, gates e caminho crítico

**Versão:** Frontend AAA³ v1.0  
**Data:** 07/09/2026  
**Plano executivo:** [FRONTEND_EXECUTIVE_PLAN.md](FRONTEND_EXECUTIVE_PLAN.md)  
**Backlog:** [FRONTEND_BACKLOG.md](FRONTEND_BACKLOG.md)  
**Diagnóstico:** [RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md](../RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md)

> Este roadmap é orientado por evidência e capacidade, não por datas artificiais. Uma onda só fecha quando o artifact, a interação e o packet correspondente satisfazem o gate. O estado inicial é REJECT para AAA e a evidência visual existente é STALE.

O roadmap é uma frente subordinada ao [programa AAA-2](AAA_2_EXECUTIVE_PLAN.md). Ele pode fechar um candidato técnico frontend, mas não autoriza produção, piloto clínico ou release sistêmico.

## 1. Objetivo do roadmap

Levar o frontend de uma base funcional, coerente e ainda genérica para uma plataforma visualmente própria, fluida, responsiva e verificável, mantendo a verdade operacional do produto.

O roadmap prioriza:

1. reduzir risco de contexto, estado e acessibilidade;
2. criar fundação visual reutilizável;
3. recuperar mobile e shell;
4. entregar attention-first, queue e drawer;
5. conectar Patient Workspace, results e notifications;
6. completar management/admin sem divergência;
7. provar o candidato com evidência current e crítica independente.

## 2. Estado de partida

| Evidência | Estado |
|---|---|
| Documentação de produto/UX | OBSERVED, rica em contratos e estados |
| Source frontend | OBSERVED, Next 16 App Router / React 19, muitas alterações pré-existentes |
| Design tokens | PARTIAL, cores/radii/sombras existem, sem escala completa |
| UI package | THIN, Surface é o primitive compartilhado central |
| Mobile | REJECT pelos críticos para 375px; rail fixo comprime o conteúdo |
| Estados | PARTIAL entre rotas; Patient Workspace é o recorte mais completo |
| Acessibilidade | automação parcial; manual NOT RUN; gaps em tabs, toggle, popover e targets |
| Motion | PARTIAL, tempos espalhados e shimmer/spin sem sistema |
| Visual packet | STALE, hashes não coincidem integralmente com source atual |
| Critic independente | dois I1 retornaram REJECT para a implementação atual |

## 3. Caminho crítico

**W0 Verdade + baseline → W1 Tokens + type + icons + primitives → W2 Shell + mobile + boundaries → W3 Attention + queues + drawer → W4 Patient Workspace + request lineage → W5 Results + notifications + critical → W6 Management + indicators + admin → W7 Motion + performance + evidence → W8 Final critique + release candidate**

### Dependências que não podem ser puladas

- W0 resolve ou explicita navegação, role/context lock, copy de status e decisões humanas mínimas.
- W1 precede a migração visual de features; sem tokens, cada rota cria uma nova exceção.
- W2 precede a validação de qualquer tela mobile.
- W3 e W4 precisam compartilhar a mesma fonte de next action, freshness e status.
- W5 depende de regras de versioning/review/acknowledgement, sem inventar política clínica.
- W7 só pode chamar um render “current” quando o fingerprint do source estiver ligado ao packet.
- W8 requer critic independente fresco; self-review não fecha o programa.

## 4. Ondas do programa

### W0 — Verdade, decisões e baseline atual

**Objetivo:** remover ambiguidade antes do redesign.

**Trabalho principal**

- fixar source fingerprint e limpar a nomenclatura v8/v9 dos packets;
- reconciliar IA, shell atual e S-11 de gestão;
- decidir o modelo mobile;
- nomear owner de navegação, role, identidade, review/completed, critical e SLA;
- criar route × role × viewport × state matrix;
- preparar fixtures de stale, partial, denied, unknown, long copy, request multi-item e homônimo sintético;
- recapturar baseline em 375/390, 768/834 e 1440.

**Saídas**

- decision register frontend;
- current source hash;
- visual packet baseline;
- route/state/viewport ledger;
- lista de bloqueios humanos;
- revisão atualizada de FB-01…FB-08.

**Gate de saída**

- nenhuma evidência anterior apresentada como current;
- modelo mobile escolhido ou explicitamente marcado BLOCKED_HUMAN;
- toda rota pública tem owner e estado de cobertura;
- packet contém viewport, role, state, timestamp, console/network e limitation.

**Risco de avanço**

Se o modelo mobile ou a política de contexto não for decidida, pode-se prototipar primitives, mas não aceitar W2 como final.

### W1 — Fundação visual e de interação

**Objetivo:** construir a gramática que impede divergência entre rotas.

**Trabalho principal**

- tokens semânticos de color, spacing, type, radius, shadow, layer e motion;
- fonte local aprovada e fallback estável;
- icon system com accessible name;
- Surface, ActionButton, IconButton, FeedbackBanner, Status, DataFreshness;
- Dialog, Drawer, Popover, Tabs, Search/Combobox e Table primitives;
- visual states e copy mapping;
- aliases de compatibilidade para migração progressiva.

**Saídas**

- contrato de primitives;
- fixture gallery local;
- token audit;
- contrast baseline;
- typography baseline;
- states matrix por componente.

**Gate de saída**

- cada primitive passa idle, hover, focus, pressed, pending, confirmed, failed, unknown e disabled conforme aplicável;
- targets críticos ≥44px;
- focus e accessible name observados;
- no raw color crítico para novos componentes;
- reduced motion definido para cada motion token.

**Risco de avanço**

Não migrar features com primitives sem semântica; “visual bonito” sem states vira dívida estrutural.

### W2 — Shell, navegação e mobile

**Objetivo:** tornar a aplicação legível e navegável nos três mundos de viewport.

**Trabalho principal**

- AppShell com nav canônica por role;
- mobile topbar + bottom navigation ou menu sheet aprovado;
- tablet 768–834 tratado como composição própria;
- Patient Context Lock reutilizável;
- loading/error/not-found boundaries de rota;
- breadcrumb, search, notification, session e realtime status;
- foco/restoration em menu, drawer e navegação;
- no horizontal overflow em action-critical regions.

**Saídas**

- shell em 375/390, 768/834, 1024/1280 e 1440;
- nav keyboard map;
- responsive behavior matrix;
- route boundary fixtures;
- mobile evidence packet.

**Gate de saída**

- nenhum rail persistente reduz a área de conteúdo abaixo do limite acordado;
- primary action, patient context e status permanecem visíveis;
- 200% zoom/reflow não esconde ações;
- no unannounced focus loss;
- source e packet são current.

### W3 — Attention cockpit, queues e drawer

**Objetivo:** entregar a primeira fatia de valor operacional State of Art.

**Trabalho principal**

- Overview attention-first;
- Command Center com freshness/degraded;
- Queue Table semântica;
- Queue Card mobile;
- filtros, busca, sort, pagination e ownership;
- Context Drawer que preserva a fila;
- next action, SLA e priority com texto/ícone;
- atualização realtime sem reorder silencioso.

**Saídas**

- / e /queues demonstráveis;
- same-truth check entre dashboard, queue e drawer;
- keyboard/touch evidence;
- long row/empty/error/stale packet.

**Gate de saída**

- atenção precede métricas decorativas;
- cada row/card tem identidade, service, status, priority, age/SLA permitido e next action;
- tabela usa semântica nativa ou equivalência justificável;
- drawer abre, fecha, restaura foco e não perde contexto;
- stale/realtime é explicitamente percebido.

### W4 — Patient Workspace e request lineage

**Objetivo:** transformar o contexto do paciente em uma superfície de decisão e auditoria.

**Trabalho principal**

- PatientIdentity/context lock;
- requests e items independentes;
- sample/accession/procedure lineage;
- partial/stale/denied/empty/ready;
- Timeline/Audit Spine;
- request detail e deep links;
- ownership e next action somente do snapshot autorizado.

**Saídas**

- /patients;
- /patients/[id]/diagnostics;
- /requests/[id];
- timeline dense/expanded fixtures;
- identity/homonym and multi-item evidence.

**Gate de saída**

- nenhuma request parcial esconde item ativo;
- patient e encounter aparecem antes de ações sensíveis;
- stale preserva último snapshot confirmado;
- denied não revela existência de recurso;
- timeline diferencia evento, versão, ator e timestamp;
- mobile não renderiza duas árvores simultâneas para o mesmo conteúdo.

### W5 — Results, review, attachments e notifications

**Objetivo:** tratar resultado e comunicação como lifecycle, não como badge.

**Trabalho principal**

- result version banner;
- draft/released/amended/void;
- viewed versus reviewed;
- review e critical acknowledgement por versão;
- attachment pending/quarantine/clean/denied;
- inbox tabs com tab/tabpanel semântico;
- critical persistent/failed/escalated;
- unknown outcome após timeout/realtime loss.

**Saídas**

- /results/[id];
- /notifications;
- version/review/attachment/critical packet;
- copy mapping sem raw enum.

**Gate de saída**

- nenhuma nova versão substitui silenciosamente a anterior;
- abrir não marca review;
- acknowledgement não é inferido de delivery/seen;
- anexo não aparece antes da autorização/scan;
- notification error conserva o estado confirmado e mostra freshness;
- tabs funcionam com teclado, aria relationship e foco.

### W6 — Indicators, management, admin, account

**Objetivo:** fazer superfícies secundárias compartilharem a mesma linguagem e verdade.

**Trabalho principal**

- indicator definitions, denominator, timezone e freshness;
- management metrics e operational tables;
- admin catalog/roles/reasons/audit;
- account/session scope;
- login accessibility and recovery;
- domain copy maps para status, priority, departments e event types;
- permission/denied/expired states.

**Saídas**

- /indicators;
- /management;
- /admin;
- /account;
- /login;
- full public route state map.

**Gate de saída**

- nenhum código cru sem tradução operacional justificada;
- métricas insuficientes não viram zero;
- admin técnico separado de comando clínico;
- role não é inferida de departamento;
- login e account têm focus/error/recovery current.

### W7 — Materialidade, motion e hardening

**Objetivo:** aplicar a assinatura visual depois que as fundações estão provadas.

**Trabalho principal**

- rail micro-grid;
- patient context field;
- timeline trace;
- button finishing;
- asset bible e papéis de mídia;
- estudos OpenDesign para composição quando a exploração editável agregar valor;
- texturas/ambient loops via ComfyUI somente após aprovação do papel;
- Blender apenas para um estudo 3D abstrato se a profundidade explicar o produto;
- motion tokens e choreography;
- reduced motion;
- font loading, asset sizing, LCP, CLS;
- refresh storm/realtime churn;
- console/network and layout shift.

**Saídas**

- visual system final candidate;
- motion matrix;
- asset/token/type audit;
- performance packet;
- content stress packet.

**Gate de saída**

- texture não compete com informação;
- motion tem job, fallback e interruption;
- no essential feedback depends on animation;
- LCP/CLS ficam dentro do budget aprovado ou há decisão explícita;
- current screenshots mostram melhora sem regressão de hierarchy.
- qualquer mídia integrada tem poster/fallback, asset manifest, budget de bytes e proveniência;
- a interface continua completa com mídia desligada ou falha de carregamento.

### W8 — AAA³ candidate, critique e release

**Objetivo:** fechar o ciclo com julgamento independente.

**Trabalho principal**

- congelar candidate source;
- gerar packet completo;
- executar accessibility manual;
- executar keyboard/focus/touch/zoom/reduced motion;
- executar visual and responsive matrix;
- rodar full regression surface;
- dois critics frescos;
- corrigir maior gap;
- recapturar após cada material fix;
- atualizar traceability e backlog.

**Saídas**

- candidate fingerprint;
- frontend evidence ledger;
- quality gates result;
- two independent critic packets;
- residual risk register;
- release recommendation.

**Gate de saída**

- FB-01…FB-08 sem required failure;
- nenhum critic REJECT;
- nenhum evidence STALE;
- no P0/P1 unresolved;
- product/clinical decisions open only outside candidate scope;
- status final pode ser PASS, CONDITIONAL PASS ou FAIL conforme evidência; nunca “AAA” por adjetivo.

## 5. Janela indicativa de capacidade

As semanas abaixo são planejamento PROPOSED para a capacidade de 1 lead + 2 frontend engineers + Design/QA/A11y parciais. Não são compromisso de release.

| Janela | Wave primária | Parallel work | Resultado esperado |
|---|---|---|---|
| 1–2 | W0 | decision register, fixtures, current packet | baseline e bloqueios |
| 3–4 | W1 | font/license, icon audit, state copy | primitive contract |
| 5–6 | W2 | route boundaries, manual keyboard | shell/mobile candidate |
| 7–8 | W3 | queue fixtures, same-truth checks | operational core |
| 9–11 | W4 | identity/lineage, timeline | patient workspace |
| 12–13 | W5 | versioning, notification semantics | result/comms |
| 14–15 | W6 | copy maps, indicator definitions | completeness |
| 16–17 | W7 | asset/type/token/perf audit | visual candidate |
| 18–20 | W8 | independent critique and rework | AAA³ candidate decision |

Se W0 durar mais por decisão externa, preservar W1 de baixa dependência e mover datas; não comprimir W2–W8 removendo evidência.

## 6. Paralelização segura

### Lanes paralelas aprovadas

- baseline/evidence e decision register, desde que ambos sejam read-only para source;
- font/icon research e token audit;
- route fixture creation e primitive implementation, com contrato de state IDs congelado;
- content mapping e visual QA de source;
- manual accessibility de uma rota concluída enquanto outra é construída.

### Lanes que devem ser sequenciais

- tokens antes de migration visual ampla;
- shell mobile antes de aprovação de qualquer screenshot mobile;
- state authority antes de motion que sinaliza estado;
- result versioning antes de visual polish de results;
- current packet antes de critic;
- critic antes de decisão de release.

## 7. Replanejamento

Reabrir a wave e marcar evidência STALE quando:

- source hash mudou depois do render;
- route/state contract mudou;
- role/permission/clinical policy mudou;
- novo critic encontra gap crítico/alto;
- browser/viewport/device mudou;
- fixture ficou irrealista ou mascara a falha;
- packet não contém evidência de interação necessária;
- performance ou accessibility check não executou.

Não transformar BLOCKED em PASS por avanço de calendário. Um bloqueio humano precisa de autoridade, decisão e registro.

## 8. Evidência por wave

| Wave | Evidência mínima |
|---|---|
| W0 | fingerprint, decision log, route/state matrix, fresh baseline |
| W1 | component fixtures, token audit, contrast, typography and state matrix |
| W2 | screenshots and keyboard map at 375/834/1440, focus restoration, zoom |
| W3 | queue/overview/drawer packet, same-truth inspection, stale/realtime |
| W4 | identity/lineage/timeline packet, multi-item and partial/stale |
| W5 | version/review/attachment/critical packet, tabs semantics |
| W6 | full route packet, copy localization and permission states |
| W7 | motion/reduced motion, LCP/CLS, asset/font/network/token audit |
| W8 | complete ledger, independent critics, final source hash and residual risk |

## 9. Demonstrações executivas

| Marco | Demonstração |
|---|---|
| M0 | abrir o mesmo patient/item em desktop, tablet e mobile sem perder identity/status/action |
| M1 | alternar button, tab, popover, drawer e dialog por teclado, incluindo erro e recuperação |
| M2 | fila abre drawer, recebe update stale/realtime e preserva foco/posição |
| M3 | request multi-item parcial mostra itens ativos e lineage de amostra |
| M4 | result amended cria nova versão sem apagar review anterior |
| M5 | critical notification permanece pendente até acknowledgement explícito por versão |
| M6 | o mesmo estado aparece no dashboard, queue, drawer e workspace |
| M7 | packet atual bate com source hash e dois critics revisam o mesmo candidate |

## 10. Definition of done do roadmap

O roadmap termina quando:

- W0–W8 têm saída documentada;
- backlog de P0/P1 do frontend não possui item aberto no caminho crítico;
- FB-01…FB-08 possuem status current;
- duas críticas independentes não encontram gap material;
- manual accessibility e performance foram executados;
- source/packet/traceability estão alinhados;
- a autoridade correta decide o nível de release.

Sem esses itens, o estado é REWORK, CONDITIONAL ou BLOCKED; nunca AAA³.
