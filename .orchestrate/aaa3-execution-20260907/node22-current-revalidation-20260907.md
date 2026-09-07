# Revalidação AAA-3 — Node 22 / PostgreSQL / browser (addendum atual)

**Data:** 07/09/2026 — pacote base e addendum current-source do ciclo corrente  
**Classificação:** evidência local sintética e condicional; não é aprovação clínica, produtiva ou de release.
**Status:** snapshot anterior preservado; superseded pelo packet corrente
[`node22-current-revalidation-post-action-20260907.md`](node22-current-revalidation-post-action-20260907.md).

## Resultado corrente

| Gate local | Resultado | Comando/ambiente |
| --- | --- | --- |
| validação ampla | **719/719 testes, 86/86 arquivos**; 92,69% statements/lines, 86,06% branches, 94,40% functions na execução full corrente | `source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate` |
| PostgreSQL integrado | **39/39 testes, 6 arquivos — packet anterior condicional** | PostgreSQL 16.15 descartável em `127.0.0.1:55495`, Node 22.23.2; a repetição current-source aguarda host com `initdb`/`pg_ctl`/Docker e está documentada em `postgres-current-rerun-node22-20260907.md` |
| browser principal | **36/36**, sem retry | `E2E_PORT_BASE=6120`, Chromium/tablet/mobile, `core-flows.spec.ts` |
| browser clínico | **9/9**, sem retry | `E2E_PORT_BASE=6160`, Chromium/tablet/mobile, `clinical-lifecycle.spec.ts` |
| acessibilidade | **9/9**, sem retry | `E2E_PORT_BASE=6200`, Chromium/tablet/mobile, `accessibility.spec.ts` |
| matriz browser completa | **57/57**, sem retry | `E2E_PORT_BASE=6400`, Chromium/tablet/mobile, core + clínico + acessibilidade + realtime |
| foco realtime | **98/98**, 7 arquivos | Vitest Node 22; adapter, stream, rota, AppShell e reconciliação |
| sentinel de mutações | **7/7 detectadas** | `nvm exec 22 npm run test:mutation`, cópia temporária |
| visual | **20 PNGs**, hashes verificados | `visual-patient-workspace-20260907/sha256-manifest.json`, SHA-256 do manifesto `ea78c5fa85c878765d617fcffd8deface30ed0df3b46dfc1b8a22148eafe1598` |

## Mudanças cobertas

- Scanner externo exige `MALWARE_SCANNER_ALLOWED_HOSTS`, aceita somente host exato aprovado, rejeita IP não allowlisted, credenciais/fragmentos e redirects (`redirect: "error"`).
- Realtime/SSE só reprocessa eventos `PENDING` ou `PROCESSED`; linhas `PROCESSING`/`FAILED` não são apresentadas como entrega concluída.
- Rate limit PostgreSQL tem prova concorrente de 12 chamadas/limite 3, reset de janela e configuração fail-fast.
- Logger HTTP estruturado limita campos/labels e redige corpo, payload clínico, credenciais, tokens, cookies e connection strings; correlações externas são normalizadas para `external`; o SBOM CycloneDX é validado localmente e publicado pelo CI.
- Patient Workspace mantém a correção de geometria mobile com topbar em fluxo normal e safe-area inferior.
- ResultView usa o ActionButton compartilhado nas ações de liberação, revisão, upload e edição/invalidação, com `data-action-state`/`aria-busy` durante transações; regressões de pending/anti-duplicate estão cobertas.

## Limites que permanecem

O runtime continua com JSONB como autoridade clínica. Permanecem abertos D-01–D-06, volume/skew/cutover relacional representativo, failover/RPO/RTO e restore completo (objetos, configuração, certificados e chaves), scanner/storage reais, secrets manager/egress, CI remoto limpo, pentest, revisão manual de acessibilidade/UX/fluxos clínicos e piloto hospitalar. O parecer independente mais recente permanece `BLOCKED`.

O cluster PostgreSQL temporário do packet base foi interrompido ao fim da
execução; a instância persistente `127.0.0.1:5432` não foi usada, parada nem
reconfigurada. A tentativa current-source não iniciou um cluster por falta de
`initdb`/`pg_ctl`/Docker e não aplicou migration.
