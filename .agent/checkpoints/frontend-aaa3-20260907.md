# Checkpoint — Frontend AAA³ — 2026-09-07

## Como retomar

1. Ler `AGENTS.md` na raiz.
2. Ler este checkpoint completo.
3. Ler `.agent/plans/frontend-aaa3-implementation-20260907.md`.
4. Ler os três documentos de produto:
   - `docs/build/FRONTEND_EXECUTIVE_PLAN.md`
   - `docs/build/FRONTEND_ROADMAP.md`
   - `docs/build/FRONTEND_BACKLOG.md`
5. Conferir `git status --short` e preservar as alterações prévias do usuário.
6. Executar primeiro `git diff --check` e `npm run typecheck` antes de continuar.

## Objetivo ativo

Implementar o frontend State of Art/Triplo AAA do CVG Diagnostics Hub conforme o
anexo lido em `/home/ricardo/.codex/attachments/6fce95d8-cfbc-495c-a0ec-ee5883bd993e/pasted-text-1.txt` e os planos em `docs/build/`. O escopo é somente frontend; domínio, API, política clínica, dados reais, produção e release permanecem fora da autoridade desta execução.

## Skills em uso

- `design-director`: direção visual, sistema de UI, motion, responsive e QA visual.
- `gauntlet-loop`: barra congelada, críticas independentes e regressão antes de declarar pronto.
- `orchestrate`: três trilhas independentes prepararam primitives sem tocar hotspots.
- `engineering-framework`: ExecPlan, gates, verificação, recovery e limites explícitos.

## Estado atual

Fase: `BUILD / FE-FOUNDATION → FE-SHELL`.

A baseline histórica do repositório é grande e deliberadamente suja. Não usar
`git reset`, `checkout` ou limpeza ampla. As alterações desta execução são:

- Novo plano: `.agent/plans/frontend-aaa3-implementation-20260907.md`.
- Novos boundaries Next: `src/app/loading.tsx`, `src/app/error.tsx`, `src/app/not-found.tsx`.
- Novos primitives de feedback: `src/components/feedback-states.tsx` e teste.
- Novo sistema SVG: `src/components/ui-icons.tsx` e teste.
- `src/components/app-shell.tsx`: navegação SVG, header e bottom navigation responsiva.
- `src/app/globals.css`: tokens AAA³, textura procedural, controles, motion,
  feedback, surfaces e reflow real em tablet/mobile.
- `packages/ui/src/index.tsx`: Surface com marcação, ActionButton e SectionHeading.

Esses arquivos podem coexistir com modificações anteriores do usuário no mesmo
checkout; revisar o diff antes de qualquer ajuste de integração.

## Decisões importantes

- O layout móvel não usa mais rail de 92px: abaixo de 960px o sidebar é
  substituído por navegação inferior com cinco entradas rápidas e safe-area.
- A textura é procedural em CSS para manter fallback determinístico e não
  bloquear a aplicação caso mídia externa não esteja disponível.
- Ícones de navegação são SVG inline tipados, com `aria-hidden` quando
  decorativos e `<title>` quando nomeados.
- Motion é tokenizado e reduzido por `prefers-reduced-motion`; ainda falta
  testar o comportamento no artifact servido.
- A falha de refresh deve preservar o último snapshot confirmado; ainda falta
  integrar `StaleNotice`/`PartialNotice` aos workspaces existentes.
- Não gerar artefato clínico fotorealista ou inferência visual de diagnóstico.

## Orquestração

Agentes já concluídos em escopos disjuntos:

- Agent de boundaries Next: criou os três arquivos de rota acima.
- Agent de ícones: criou `ui-icons.tsx` e teste.
- Agent de feedback: criou `feedback-states.tsx` e teste.

Todos relataram typecheck/lint/teste focado verde no próprio escopo; a
integração atual ainda precisa de verificação do coordenador.

## MCP e mídia

- ComfyUI: conectado e ativo em `127.0.0.1:8188`; hardware local detectado:
  NVIDIA RTX 3060 com 12 GB VRAM. Imagens locais são viáveis; vídeo local é
  potencialmente lento e não é requisito para desbloquear o frontend.
- OpenDesign: tentativa de `get_active_context`/`list_projects` falhou com
  `Transport closed`; não assumir que geração ocorreu.
- Blender: não conectado em `localhost:9876`; nenhum arquivo/scene foi alterado.
- Próxima decisão: só gerar texture/hero asset com ComfyUI após definir papel
  visual e verificar integração; CSS/SVG continuam sendo o fallback oficial.

## Próximos passos obrigatórios

1. Rodar typecheck/lint/testes após as alterações de shell/CSS.
2. Integrar `StaleNotice`/`PartialNotice` em notificações, gestão e resultado,
   sem apagar dados confirmados após erro de refresh.
3. Corrigir semântica das tabs de notificações e foco/keyboard dos toggles e
   workflow action.
4. Humanizar enums/códigos visíveis no management, result history e requests.
5. Verificar queue/result table overflow em 834/390/375.
6. Inspecionar artifact servido com Playwright e capturar estados ready/loading/
   error/empty/partial/stale nos quatro viewports.
7. Rodar crítica visual e crítica UX em contexto fresco; corrigir findings.
8. Rodar suite proporcional: Vitest focado, typecheck, lint, build e E2E/a11y.
9. Atualizar este checkpoint com comandos/resultados; só então decidir se um
   asset ComfyUI acrescenta valor.

## Limitações não resolvidas

- Sem aceite clínico/hospitalar humano.
- Sem screen reader/touch manual.
- Sem validação de produção/target/remote CI.
- Sem conexão operacional do OpenDesign e Blender.
- AAA³ ainda NÃO está concluído; este arquivo é um ponto de retomada, não um
  veredito de release.

## Validação da integração inicial — 2026-09-07

A integração FE-FOUNDATION → FE-SHELL foi validada no checkout sujo existente,
preservando todas as alterações prévias. O resultado é suficiente para avançar
para estados de dados/semântica clínica, mas não é uma certificação de release
AAA³.

Alterações confirmadas:

- Boundaries e fallbacks de loading/error/404 com regiões semânticas, busy/live
  states, retry e heading recuperável.
- Ícones de ação e navegação em SVG tipado; prioridades e métricas não usam
  glyphs Unicode como ícones.
- Navegação mobile fixa com cinco entradas também para ADMIN, com estado ativo
  por pathname/hash; reflow real abaixo de 960px.
- Contraste corrigido para pistas auxiliares, estados vazios, login/404 e
  navegação inativa; scroll-padding/scroll-margin evita que header/nav cubram
  ações de admin em tablet.
- Enums visíveis humanizados em gestão, indicadores, busca, requests, timeline,
  histórico de resultados e escopo de gestão. O escopo agora deriva do array de
  departamentos localizado no cliente, sem alterar o contrato/API.
- Error state estreito agora quebra controles sem largura intrínseca excedente;
  probe servido em 375px confirmou `html` e `body` em 375/375.

Evidência executada após a última correção:

- `npx vitest run src --passWithNoTests`: **78 arquivos / 641 testes PASS**.
- `npm run typecheck`: **PASS**.
- `npm run lint`: **PASS**.
- `git diff --check`: **PASS**.
- `npm run build`: **PASS**, 12 rotas geradas pelo Next 16.3.0.
- `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0`: **51/51 PASS** em Chromium, tablet e mobile.
- Servidor E2E isolado em `:3400`: `/api/v1/livez` **200**, `/api/v1/readyz` **200**; a11y servida **6/6 PASS** nas três configurações.
- Probe autenticado servido em 375px: `Internação · Laboratório · Radiologia · Ultrassom`; `/requests/nonexistent` sem overflow horizontal.

Críticas independentes:

- Findings anteriores de loading semântico, contraste, glyphs, navegação ADMIN
  e enums foram corrigidos e retestados.
- A crítica fresca final não reportou defeito confirmado, mas ficou **CONDITIONAL**
  porque o harness do crítico travou no `waitForResponse` do login antes de
  completar a matriz autenticada. A evidência autenticada local é coberta pelos
  51 E2E, pelo probe manual de login/gestão/request fallback e pelo a11y servido.

Próxima retomada: avançar para a integração de estados de dados, stale/partial
e semântica clínica; manter pendentes a validação manual por screen reader,
touch/zoom/real device, produção/remote CI e aceite clínico/hospitalar. Não
declarar AAA³ ou release final antes dessas evidências.
