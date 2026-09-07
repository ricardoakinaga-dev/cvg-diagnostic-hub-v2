# V2 Patient Workspace — evidência local

**Data:** 05/09/2026 19:30–21:25 BRT  
**Escopo:** projeção server-owned na rota existente `GET /patients/{patientId}/diagnostics`, contrato OpenAPI, UI responsiva e regressão local.  
**Ambiente:** dados sintéticos; memória no browser; nenhum dado clínico real.

## Resultado executado

| Verificação | Resultado |
| --- | --- |
| TypeScript | PASS — `npx node@22 ./node_modules/typescript/bin/tsc --noEmit` |
| Lint | PASS — `npm run lint` |
| Testes e cobertura | PASS — 543/543 testes em 66 arquivos; 91,47% statements/lines, 85,51% branches, 94,17% functions |
| Build | PASS — Next.js 16.3.0 production build |
| OpenAPI/runtime | PASS — Redocly + drift; 65 operações em 60 paths |
| Documentação/rastreabilidade | PASS — 56 arquivos; 43 requisitos e 43 ACs ligados a código, teste, comando e evidência |
| Migrações | PASS — migrations 001–008 e checksums validados |
| Segurança/supply chain | PASS — secret scan; `npm audit --audit-level=high` com 0 vulnerabilidades |
| Performance/recovery | PASS — 7/7 testes determinísticos; 5/5 contratos de recovery |
| Browser | PASS — 51/51 Playwright, sem retry, Chromium/tablet/mobile; Patient Workspace e refresh stale incluídos |
| Acessibilidade | PASS — 6/6 cenários axe/keyboard nos três projetos, após a correção de escopo |
| PostgreSQL | BLOCKED BY GUARD — 10 testes reais não iniciados sem `ALLOW_POSTGRES_INTEGRATION_TESTS=true` e URL administrativa; 6 testes do harness passaram |

## Cobertura da fatia

- A aplicação junta identidade, encounter/admission, requests, items, contexto
  operacional, sample, resultado liberado, anexos limpos/finalizados, próximas
  ações e timeline no mesmo snapshot `asOf`.
- Para `LAB_TECH`, `RADIOLOGY_TEAM`, `ULTRASOUND_TEAM` e `MANAGER`,
  `encounters/admissions` ficam limitados aos requests visíveis; a regressão
  cobre um atendimento paralelo não autorizado.
- A autorização é reaplicada antes da projeção; draft, versão não liberada,
  item fora do escopo, `storageKey`, tokens e conteúdo binário não entram no
  workspace.
- A rota e o runtime response foram validados contra o schema OpenAPI; testes
  de aplicação cobrem o join completo e o filtro por ator/setor.
- A UI possui loading estável, erro seguro com retry/retorno, vazio, snapshot
  stale/degraded não bloqueante com reconciliação, links profundos para
  request/result, proteção contra respostas obsoletas na troca de paciente,
  contexto de emergência sem internação e layout verificado em 1440×1000,
  834×1194 e 375×812. Os screenshots de inspeção foram gravados em
  `/tmp/cvg-patient-workspace-chromium.png`,
  `/tmp/cvg-patient-workspace-tablet.png` e
  `/tmp/cvg-patient-workspace-mobile.png`.

## Integridade do artefato

Digest SHA-256 composto, com as linhas de checksum ordenadas
lexicograficamente, dos arquivos de contrato, implementação, OpenAPI,
estilos e testes da fatia após a última correção:
`21756d3f53328997d6554e7a83a034b41249cb60f8e3a8ed2319f0ff14455044`.
O manifesto reproduzível está em
[`v2-patient-workspace-manifest.txt`](v2-patient-workspace-manifest.txt);
aplica-se `while IFS= read -r path; do sha256sum "$path"; done < .orchestrate/evidence/v2-patient-workspace-manifest.txt | LC_ALL=C sort | sha256sum`.

## Limites

Esta é evidência local condicional. Não prova browser contra PostgreSQL,
fanout realtime multi-instância, carga hospitalar representativa, restore de
object storage, políticas clínicas assinadas, acessibilidade manual, aceite
hospitalar ou autorização de release.

## Crítica independente

Três checkpoints read-only frescos foram solicitados em contextos separados;
nenhum worker devolveu um veredito dentro das janelas limitadas e todos foram
encerrados. Status: `NOT_RUN`; isso não é contado como aprovação independente.
A checagem de integridade confirmou que os workers não alteraram os arquivos
inspecionados.
