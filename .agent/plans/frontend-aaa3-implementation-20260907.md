# CVG Diagnostics Hub — ExecPlan de implementação frontend AAA³

## Objetivo

Implementar a camada frontend do programa State of Art definido em
`docs/build/FRONTEND_EXECUTIVE_PLAN.md`, preservando o domínio/API existentes e
sem criar autoridade clínica no cliente. A entrega prioriza uma superfície
operacional bonita, fluida, acessível, responsiva e honesta sobre estados de
dados.

## Estado inicial recuperado

- O checkout é brownfield e está deliberadamente sujo; alterações anteriores
  do usuário não serão revertidas.
- Next.js 16/App Router e React 19.2 foram confirmados nos guias locais antes
  de qualquer código.
- A baseline técnica histórica está verde em grande parte, mas a revisão
  visual independente rejeitou o frontend por rail estreito em mobile, ícones
  Unicode, estados inconsistentes, overflow em tablet e motion não verificável.
- OpenDesign e Blender estão desconectados; ComfyUI local está disponível para
  imagens auxiliares, sem dependência obrigatória do runtime.

## Escopo da execução

1. Fundamentos: tokens, textura procedural, tipografia segura, motion tokens,
   focus states, botões e superfícies coerentes.
2. Shell: ícones SVG acessíveis, navegação desktop/tablet/mobile, header e
   bottom navigation sem comprimir labels clínicos.
3. Estados: loading/error/empty/partial/stale com preservação do último dado
   confirmado, boundaries do App Router e tabs semânticas.
4. Workspaces: gestão, notificações, fila e resultado com labels humanos,
   foco/keyboard, overflow controlado e ações de consequência explícita.
5. Verificação: typecheck, lint, testes Vitest focados, build Next, E2E e
   auditoria visual fresca em viewports 1440/834/390/375.

## Grafo de execução

```text
FE-FOUNDATION (serial: globals/layout/ui)
  -> FE-SHELL (serial: AppShell + icons)
  -> FE-STATE (notifications/result/management)
  -> FE-RESPONSIVE (CSS + focused tests)
  -> FE-VERIFY (unit/type/lint/build/E2E + fresh critics)
```

Primitives independentes podem ser preparados em paralelo, mas `globals.css`,
`AppShell` e componentes de rota são hotspots de integração e pertencem ao
coordenador.

## Critérios de aceite locais

- Nenhum ícone de navegação depende de Unicode; todo ícone decorativo é
  `aria-hidden` e todo controle tem nome acessível.
- Em 834px não existe grid de seis métricas sem reflow; em 390/375px não há
  rail que roube a largura do conteúdo.
- Falha de refresh mantém dados confirmados visíveis e mostra idade/estado
  stale; falha de leitura inicial oferece retry sem tela vazia ambígua.
- Tabs usam `role=tablist`, `role=tab`, `aria-selected`, `aria-controls` e
  painel associado; toggles têm foco visível e estado programático.
- `prefers-reduced-motion` desativa transições/animações não essenciais.
- O cliente não infere criticidade, autorização, status clínico ou política de
  escalonamento; apenas apresenta contratos existentes.

## Limitações explícitas

Imagens/vídeo gerados por MCP só entram após papel visual claro, inspeção do
artefato e fallback local. A ausência de OpenDesign/Blender conectados não
bloqueia o frontend. Aceite clínico, manual de screen reader, produção e
release continuam gates humanos fora deste plano.

## Registro de verificação

Será preenchido ao final com comandos, resultados e limitações observadas. Não
marcar AAA³ completo sem inspeção do artifact servido e crítica independente.
