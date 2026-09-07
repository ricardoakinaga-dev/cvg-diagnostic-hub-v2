# Evidência AAA-3 — browser production-like local após correção de shutdown

**Data:** 07/09/2026 04:47 (America/Sao_Paulo)  
**Classificação:** evidência local sintética; não é aprovação de produção, clínica ou release.

## Ambiente isolado

- Node `v22.23.2`, npm `10.9.8`.
- PostgreSQL `16.15` descartável, cluster novo em `127.0.0.1:55481`, banco `cvg_test_aaa3_browser`.
- Next.js `16.3.0` servido por `next start` em `127.0.0.1:5730`.
- Migrations `001–010` aplicadas e seed sintético autorizado somente no banco dedicado.
- Serviço S3-compatible sintético e scanner HTTPS sintético EICAR/CLEAN em portas efêmeras.
- Worker outbox separado com sink PostgreSQL durável, `postgres-listen` e rate limit PostgreSQL.
- A instância persistente em `127.0.0.1:5432` não foi usada ou alterada.

## Comandos e resultado

1. `npm run db:migrate`: PASS; migrations `001–010`.
2. `ALLOW_SYNTHETIC_SEED=true NODE_ENV=development npm run db:seed`: PASS.
3. `NODE_ENV=production npm run build`: PASS; 12 páginas/rotas geradas.
4. `/api/v1/readyz`: HTTP `200`, `status=ready`, `dataMode=postgres`, `storageMode=s3`.
5. `CI=1 BASE_URL=http://127.0.0.1:5730 E2E_REUSE_EXISTING_SERVER=true npm run test:e2e -- --retries=0 --fail-on-flaky-tests`: **51/51 PASS**, em Chromium, tablet e mobile, duração `6.9m`, sem retry.

A matriz contém os cenários de acessibilidade 6/6, ciclo clínico 9/9 e fluxo principal 36/36. O fluxo clínico exercita upload/download limpo, outbox, critical acknowledgement, review, amendment e void.

## Encerramento

Após SIGTERM, o worker, servidor, serviços sintéticos e PostgreSQL foram encerrados ordenadamente. As portas `55481` e `5730` ficaram livres, não restaram processos do lane e a varredura do log do worker não encontrou `Unhandled`, `worker_fatal`, `Connection terminated` ou `outbox.worker_error`.

Hashes dos logs brutos mantidos no diretório temporário `/tmp/cvg-aaa3-browser.BWCeBb/logs/` no momento da captura:

| Artefato | SHA-256 |
| --- | --- |
| `playwright.log` | `202bb4488a3a679a2cb6719766987a87ce21e6271eeaad75385eac54de62bae5` |
| `build.log` | `ed8d02a6f69505dd96b4d44c30296ef396659301745b9384bfca670bd6f39d01` |
| `migrate.log` | `b48314f85bf098882fc97c354ede02624588f1afa4a625b187d0de636dc9dcf9` |
| `outbox.log` | `1602e012c4207cca340852d7979a1f84aefb147c7a7efebf9e2813537d3fa102` |
| `storage.log` | `80ced75ecc70dbfbb15ff4a983dc01281454ad7bb8c99488f580a8897e4a26b2` |

## Limitações

Este lane fecha a prova local integrada de PostgreSQL, storage/scan sintéticos, worker e browser servido em produção. Ele não prova CI remoto, storage/AV real, IdP/TLS/segredos institucionais, workload representativo, failover/restore/RPO/RTO, cutover relacional, decisões D-01–D-06, acessibilidade manual, aceite clínico ou piloto.
