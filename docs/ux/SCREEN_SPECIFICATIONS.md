# Screen specifications

**Knowledge status:** `DECISION/PROPOSAL` de telas e estados; conteúdo clínico/roles finais dependem das `OPEN QUESTIONS`.

Cada tela define objetivo, usuário, dados e estados. Textos são exemplos em `pt-BR`.

## S-01 — Visão geral / atenção agora

- Purpose: responder o que precisa de atenção.
- Primary users: todos, conteúdo por escopo.
- Data: resultados novos, críticos, recoletas, atrasados, minha fila.
- Primary action: abrir item/contexto.
- Secondary: filtrar por setor/período.
- Loading: skeleton por bloco; não mostrar zero falso.
- Empty: “Nenhuma ação pendente no seu escopo.”
- Error: manter última leitura com timestamp + retry; não ocultar falha.
- Partial/degraded: bloco indisponível identificado.
- Realtime: invalidar cards e refetch autorizado.
- Mobile/accessibility: cards empilhados, headings, landmarks, live region para nova ação não crítica.

## S-02 — Nova solicitação

- Purpose: criar request curta.
- Primary: usuário de cuidado.
- Entry: patient/encounter, command palette, botão global.
- Data: contexto pré-preenchido, catálogo/busca, prioridade, observação opcional.
- Secondary: favoritos/recentes/painel quando ativados.
- States: loading de catálogo, empty “Nenhum serviço encontrado”, validation inline, duplicate warning, submitting, unknown/retry.
- Permissions: create request; server revalida.
- Realtime: após sucesso, request aparece na fila.
- Mobile: seleção e resumo em etapas simples; sem formulário gigante.
- Accessibility: labels, autocomplete announced, selected chips removíveis por teclado, foco no erro.

## S-03 — Central de Exames / fila

- Purpose: executar trabalho operacional.
- Users: Lab, Image, managers.
- Data: item, patient bundle, service, priority, state, SLA/age, next action.
- Actions: receive/start/schedule/perform/recollection/release conforme role.
- Filters: status, priority, service, patient, date, overdue; persistência opcional por usuário.
- States: skeleton; empty com próxima ação; error/retry; partial with stale timestamp; offline banner.
- Realtime: row update; preserve active filters and scroll sensibly.
- Mobile: compact cards for next action, complex table desktop-first.
- Accessibility: table semantics, sort labels, no color-only priority, keyboard row action.

## S-04 — Request/item detail

- Purpose: contexto completo e próxima ação.
- Data: patient/encounter/admission, request code, item cards, count, timeline, audit summary, attachments.
- Actions: command contextual; cancel only if allowed; open result.
- States: item partial, conflict banner, permission-limited fields, not found/expired link.
- Realtime: show “atualizado agora” and offer refresh if active edits conflict.

## S-05 — Meus pacientes

- Purpose: visão simples por paciente para cuidado/internação.
- Data: patient identity bundle, location, item status, result age, critical/recollection/overdue.
- Primary: open result/action.
- Empty: “Nenhum paciente atribuído neste momento.”
- Error/degraded: last successful refresh and retry.
- Mobile: patient cards; no dense unfiltered list.
- Patient page (PROD-406): "Atendimentos" panel with the open encounter and the history; "Novo atendimento" when none is open and "Encerrar atendimento" (confirmation with optional reason) when one is, both role-gated; status is always written ("Em aberto", "Encerrado em …").

## S-06 — Result entry/release

- Purpose: draft, validate and release a result/report.
- Users: executor authorized.
- Data: item context, schema fields, narrative/conclusion, attachments, critical flag only if policy permits.
- States: draft autosave where supported, validation, upload progress/quarantine, release confirmation, conflict, server confirmed.
- Empty: no result draft → create with service schema.
- Realtime: after release notify; draft remains private until release.
- Accessibility: fieldset/legend, unit/read-only labels, focus on failed upload/validation.

## S-07 — Result/review

- Purpose: view, review, acknowledge critical.
- Data: current version, version history permitted, author/release/amendment metadata, attachments, timeline.
- Actions: View (automatic), Review, Acknowledge, request clarification/operational action if enabled.
- States: loading, released, amended/re-review required, attachment unavailable, stale version, denied.
- Realtime: version update invalidates review button and explains why.

## S-08 — Notifications inbox

- Purpose: centralizar informação acionável.
- Tabs: Novas/Não lidas/Ação necessária/Todas.
- States: empty per tab, failed delivery marker, critical unacknowledged persistent.
- Accessibility: unread/priority text, keyboard open/ack, live announcement with user preference constraints.

## S-09 — Indicadores

- Purpose: intervene in queues, not BI.
- Data: overdue, volume, turnaround distributions, recollection, critical ack, by service/priority.
- Every chart/table shows definition, time window, timezone, last update and denominator.
- Empty/insufficient data says so; no fabricated zeros.

## S-10 — Administração

- Purpose: configure catalog, roles, reasons, SLA and policies.
- Users: admin/manager with delegated permission.
- Actions: version/deactivate, never delete referenced clinical values.
- States: validation, audit, conflict, effective date preview, permission denied.

## S-11 — Centro de gestão operacional

- Purpose: give a manager one scoped control surface for diagnostic flow, capacity and access decisions.
- Navigation: Controle, Solicitações, Pendências, Estatísticas, Acessos, Catálogos and Auditoria.
- Data: one server snapshot with active/overdue/recollection/new-result/critical counters, department rollups, pending items with next action/deep link and recent requests.
- Scope: own department plus explicitly delegated diagnostic departments; every query and mutation is re-authorized server-side.
- States: loading, partial/error with reconciliation, empty scope, up-to-date snapshot and stale-data warning.
- Accessibility: named tab navigation, semantic metric/panel regions, keyboard-safe forms and no reliance on color alone for priority/status.
