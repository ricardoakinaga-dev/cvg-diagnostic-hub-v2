# Browser E2E final após correção de contraste — 2026-09-07

## Comando

```text
source /home/ricardo/.nvm/nvm.sh && E2E_PORT_BASE=6550 nvm exec 22 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

## Resultado

- Node `22.23.2`.
- `60/60` testes passaram em `5,7m`.
- Chromium, tablet e mobile passaram sem retry, com
  `--fail-on-flaky-tests` habilitado.
- A matriz inclui login, dashboard, filas, notificações, pacientes, Patient
  Workspace, ciclo clínico, realtime, conta, gestão e administração.
- O contrato Axe dedicado passou `12/12` em Chromium/tablet/mobile e cobriu,
  além das rotas clínicas, as visões de gestão e os quatro anchors da
  administração. As regras selecionadas incluem `color-contrast`, nomes,
  labels, headings, landmarks, links, roles e `tabindex`.
- O run final regenerou as capturas do Patient Workspace; os `20` PNGs e seus
  hashes estão registrados em
  [`sha256-manifest.json`](../evidence/visual-patient-workspace-20260907/sha256-manifest.json).
- PostgreSQL persistente `127.0.0.1:5432` não foi tocado.

## Escopo do hardening

O candidato mantém proteção contra respostas assíncronas obsoletas e estados
de ação explícitos em filas, pacientes, solicitações, resultados, indicadores,
gestão, administração e Patient Workspace. A correção adicional torna a regra
de cor do breadcrumb específica; o Axe confirmou contraste sem violações nas
três larguras.

Este packet é evidência automatizada local. Não equivale a revisão manual com
leitor de tela, toque, zoom ou reduced motion, aceite clínico/hospitalar,
infraestrutura alvo, autoridade relacional/cutover ou autorização de release.
