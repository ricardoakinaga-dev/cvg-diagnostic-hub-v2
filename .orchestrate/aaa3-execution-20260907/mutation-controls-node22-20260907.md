# Mutation controls AAA-3 — Node 22

**Comando:** `source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run test:mutation`  
**Data da execução:** 07/09/2026  
**Status:** `PASS` — **7/7 mutações detectadas**.  
**Isolamento:** o harness copia o workspace para diretório temporário, liga somente `node_modules` ao workspace e restaura cada arquivo mutado antes de seguir; nenhum arquivo do working tree é mutado pelo experimento.

| ID | Fronteira mutada | Suíte focal | Resultado |
| --- | --- | --- | --- |
| MC-AUTH-001 | remove a verificação de permissão da autorização server-side | `authorization.test.ts` | Detectada; suíte falha |
| MC-VERSION-001 | desabilita a rejeição de `expectedVersion` obsoleto | `service.test.ts`, `catalog.test.ts` | Detectada; suíte falha |
| MC-MIGRATION-001 | desabilita a comparação do checksum imutável da migration | `migrations.test.ts` | Detectada; suíte falha |
| MC-UPLOAD-001 | aceita MIME declarado fora da allowlist | `attachments.test.ts` | Detectada; suíte falha |
| MC-OUTBOX-001 | permite finalizar uma mensagem sem lease vigente | `outbox.test.ts` | Detectada; suíte falha |
| MC-REALTIME-001 | permite replay de linha `PROCESSING` | `realtime-stream.test.ts` | Detectada; suíte falha |
| MC-RECOVERY-001 | ignora divergência de checksum/tamanho no restore | `recovery-manifest.test.ts` | Detectada; suíte falha |

## Interpretação

O resultado prova que as suítes focais são sensíveis a essas sete classes de regressão deliberada no ambiente local. Não prova mutation score global, resistência a mutações não catalogadas, identidade institucional, infraestrutura-alvo, operação distribuída ou aprovação clínica; esses gates continuam abertos.
