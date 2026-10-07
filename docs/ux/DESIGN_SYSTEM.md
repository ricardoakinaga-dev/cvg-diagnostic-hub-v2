# Design system direction

**Knowledge status:** `DECISION/PROPOSAL` visual e de acessibilidade; budgets e validação de uso serão produzidos no BUILD/piloto.

**Estado refletido: 01/10/2026 (AUD-025).** Os tokens da seção 2 e o inventário da seção 3 foram reconciliados com `src/app/globals.css`, `src/` e `packages/`. Componente que não existe no código não é listado como existente; o que existe apenas como markup inline aparece marcado como tal.

## 1. Experience target

Premium, hospitalar, moderna, limpa e funcional. Informação e ação dominam a interface; efeitos decorativos não podem competir com status clínico.

## 2. Tokens (padrão Plane, D-029 — `src/app/plane.css`)

**Estado refletido: 06/10/2026.** A experiência segue o Plane adaptado ao hospital (D-029). `src/app/plane.css` carrega depois de `globals.css`, define os tokens com os valores do design system do Plane (`@makeplane/propel`) e remapeia os tokens legados (`--ink`, `--paper`, `--teal`, `--radius-*` etc.) para a mesma paleta, de modo que telas antigas e novas leiam como um produto só.

- superfícies — `--bg-canvas` (cinza neutro de fundo), `--surface-1` (painéis brancos), `--layer-1` (cabeçalhos de grupo), `--layer-hover`/`--layer-selected`; bordas finas `--border-subtle`, `--border-subtle-1`, `--border-strong`.
- texto — `--txt-primary`, `--txt-secondary`, `--txt-tertiary`, `--txt-placeholder`, `--txt-accent`.
- marca — `--accent` (azul do Plane), `--accent-hover`, `--accent-subtle`; estados semânticos `--success*`, `--warning*`, `--danger*`.
- estados do workflow — `--state-unstarted`, `--state-started`, `--state-review`, `--state-completed`, `--state-attention`, `--state-cancelled`, desenhados pelo `StateIcon` (círculo preenchido pelo progresso, check, exclamação ou x); prioridade por `PriorityIcon` (quadrado vermelho para emergência, barras para urgente e rotina). Cor nunca aparece sem rótulo ou ícone.
- radius — 4–6px em pílulas, botões e campos; 8px em painéis e menus; 10px em diálogos.
- elevação — `--shadow-raised-100/200` em cards e `--shadow-overlay` em menus, diálogos e peek; superfícies planas, sem texturas.
- tipografia — `--font-ui` (Inter quando instalada, senão a fonte do sistema), corpo de 13px; `--font-mono` em protocolos; números tabulares em chaves, contagens e prazos.
- densidade — Plane: linhas de 44px, itens da sidebar de 30px e botões de cabeçalho de 28px **com mouse**.
- alvo de interação — 44px continua o piso no toque: `@media (pointer: coarse)` e telas até 960px elevam links da navegação, botões, itens de menu e ações de linha a 44px; a navegação inferior móvel tem 50px. Com mouse fino, a densidade do Plane fica acima do mínimo de 24px do WCAG 2.5.8. Foco visível com contorno de 3px.

## 3. Shared components — inventário real em 01/10/2026

### Existem como componente exportado

| Componente | Origem | Observação |
| --- | --- | --- |
| `PriorityBadge` | `src/components/status-badge.tsx` | Rotina/Urgente/Emergência com texto e ícone; usado em fila, dashboard, detalhe e workspace. |
| `StatusBadge` | `src/components/status-badge.tsx` | Status do item com rótulo em pt-BR (`statusLabel`). |
| `EmptyState`, `ErrorState`, `LoadingState`, `StaleNotice`, `PartialNotice` | `src/components/feedback-states.tsx` | Kit de feedback com `aria-live`; consumido hoje por `notifications-view.tsx` e `management-dashboard.tsx` (ACHADO AUD-027: demais telas ainda fazem markup próprio). |
| `Surface`, `ActionButton`, `SectionHeading` | `packages/ui/src/index.tsx` (`@cvg/ui`) | Primitivos de layout/ação compartilhados; `ActionButton` tem `tone` e `state`. |

### Workspace no padrão Plane (D-029, 06/10/2026)

| Componente | Origem | Observação |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Barra superior (workspace, busca Ctrl+K, tempo real, caixa de entrada, menu do usuário), sidebar recolhível com setores expansíveis e painel principal. |
| `PageHeader` | `src/components/page-header.tsx` | Breadcrumb fixo com contagem e ações; o último item é o `h1` da página. |
| `WorkItemsView` | `src/components/work-items/work-items-view.tsx` | Exames em Lista, Quadro, Calendário e Planilha; filtros com chips; menu Exibição; atalhos `C` e `/`; avisos (toasts). |
| `PeekOverview` | `src/components/work-items/peek-overview.tsx` | Painel lateral não modal com propriedades, ações clínicas (`WorkflowAction`) e atividade; tela cheia no celular. |
| `StatePill`, `NextActionButtons`, `WorkItemProperties` | `src/components/work-items/properties.tsx` | Mudança de estado só pelas transições permitidas ao perfil; próxima ação em um clique. |
| `StateIcon`, `PriorityIcon`, `DepartmentIcon`, `Avatar` | `src/components/work-items/icons.tsx` | Glifos de estado, prioridade, setor e iniciais. |
| `Home` | `src/components/home-view.tsx` | Saudação, atalhos com contadores, atenção, resultados para revisar, setores e recentes. |

### Existe só como markup inline (sem componente próprio)

- **SLA / atraso** — rótulo “Prazo”, `formatRelativeTime` e a classe `row-overdue` na fila; não há `SlaIndicator`.
- **Identidade do paciente** — `div.patient-identity-tags` em `src/components/patient-diagnostics.tsx` e o bloco `patient-avatar`; não há `PatientIdentity` no front (existe apenas `normalizePatientIdentity`/`resolvePatientIdentity` no domínio do servidor).
- **Timeline** — `<ol class="timeline">` montado em `request-detail.tsx` e `patient-diagnostics.tsx`.
- **Linha de notificação** — `NotificationRow` é função local de `src/components/dashboard.tsx`, não exportada.
- **Card da fila** — `QueueCard` é função local de `src/features/diagnostics/exam-queue.tsx`.
- **Skeleton** — não há componente exportado; existem `DashboardSkeleton`/`PatientWorkspaceSkeleton` locais e as classes `.skeleton-*` de `globals.css`.
- **Diálogo de confirmação e banner offline** — sem componente próprio: confirmações são formulários com `confirm: true` e foco gerido por `use-dialog-focus.ts`; offline/degradado aparece como `realtime-banner` com `role="status"`.

### Conceitos ainda ausentes do código (não inventar)

Os itens abaixo não existem hoje e saem do inventário como componentes, ficando como direção de design a ser construída: `DiagnosticStatus`, `SlaIndicator`, `PatientIdentity`, `QueueTable`, `ResultVersionBanner`, `CriticalAlert`, `AuditSummary`, `OfflineBanner`, `ConfirmationDialog`.

## 4. Interaction rules

- progressive disclosure for notes, attachments, advanced filters and admin fields;
- server-confirmed final state for clinical actions;
- contextual action is close to the item; destructive actions require proportionate reason/confirmation;
- feedback remains visible for critical actions; toast alone is insufficient;
- no disabled button without explanation when permission/state blocks action;
- loading preserves context; prevent double submit and show pending state.

## 5. Accessibility

Target WCAG 2.2 applicable: semantic HTML, visible focus, keyboard order, accessible names, contrast, target size, error association, live region restraint, reduced motion and no color-only status. Automated checks plus keyboard/screen-reader manual pass are required.

## 6. Content guidelines

Use plain Portuguese, action verbs and context:

- “Resultado disponível para Thor · Hemograma · liberado há 4 min”;
- “Amostra insuficiente — solicite uma nova coleta para continuar”;
- “Atualização não confirmada. Verifique a fila antes de repetir.”

Avoid “Erro 500”, unexplained codes, blame and false certainty.
