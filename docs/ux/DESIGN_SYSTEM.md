# Design system direction

**Knowledge status:** `DECISION/PROPOSAL` visual e de acessibilidade; budgets e validação de uso serão produzidos no BUILD/piloto.

**Estado refletido: 01/10/2026 (AUD-025).** Os tokens da seção 2 e o inventário da seção 3 foram reconciliados com `src/app/globals.css`, `src/` e `packages/`. Componente que não existe no código não é listado como existente; o que existe apenas como markup inline aparece marcado como tal.

## 1. Experience target

Premium, hospitalar, moderna, limpa e funcional. Informação e ação dominam a interface; efeitos decorativos não podem competir com status clínico.

## 2. Tokens (reconciliados com `src/app/globals.css`)

- radius — tokens reais em `:root` (`src/app/globals.css` linhas 28–31): `--radius-sm: 10px`, `--radius-md: 16px`, `--radius-lg: 24px`, `--radius-xl: 32px`. A proposta anterior de “8–12px para cards/inputs” não corresponde ao código e foi removida; superfícies grandes usam `--radius-md` (16px) e acima.
- color — tokens reais: `--ink/--ink-soft/--ink-faint`, `--paper/--surface/--surface-muted`, `--line/--line-strong`, `--navy/--navy-deep`, `--teal/--teal-dark/--teal-action/--teal-soft`, `--coral/--coral-soft`, `--amber/--amber-dark/--amber-soft`, `--blue/--blue-soft`. Todo par de status mantém rótulo ou ícone junto da cor.
- elevation — `--shadow-sm`, `--shadow-md`, `--shadow-lg`; agrupamento nunca depende só de sombra.
- motion — `--motion-fast: 160ms`, `--motion-base: 240ms`, `--motion-slow: 520ms`, com `--ease-out` e `--ease-spring`; `prefers-reduced-motion` respeitado na regra global.
- typography — `--font-sans` (UI) e `--font-display` (títulos editoriais) são tokens reais; o uso de números tabulares (`font-variant-numeric: tabular-nums`) em tempos e contagens **ainda não existe** no CSS e permanece proposta de BUILD.
- spacing — **ainda proposta**: escala de base 4px e ritmo maior de seção não existem como tokens em `:root`; os espaçamentos hoje são valores por componente. Uniformizar é trabalho de BUILD.
- density — `comfortable` é o padrão; `compact` para filas de laboratório **após validação de usuário**. Não há token de densidade no CSS.
- alvo de interação — 44px é o piso já aplicado em `.nav-link` (`min-height: 44px`), `.icon-button` e `.notification-trigger` (44×44px), conforme a régua do E2E de acessibilidade; há ainda ações e campos entre 26 e 32px fora dessa régua (ACHADO AUD-026/F-15).

## 3. Shared components — inventário real em 01/10/2026

### Existem como componente exportado

| Componente | Origem | Observação |
| --- | --- | --- |
| `PriorityBadge` | `src/components/status-badge.tsx` | Rotina/Urgente/Emergência com texto e ícone; usado em fila, dashboard, detalhe e workspace. |
| `StatusBadge` | `src/components/status-badge.tsx` | Status do item com rótulo em pt-BR (`statusLabel`). |
| `EmptyState`, `ErrorState`, `LoadingState`, `StaleNotice`, `PartialNotice` | `src/components/feedback-states.tsx` | Kit de feedback com `aria-live`; consumido hoje por `notifications-view.tsx` e `management-dashboard.tsx` (ACHADO AUD-027: demais telas ainda fazem markup próprio). |
| `Surface`, `ActionButton`, `SectionHeading` | `packages/ui/src/index.tsx` (`@cvg/ui`) | Primitivos de layout/ação compartilhados; `ActionButton` tem `tone` e `state`. |

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
