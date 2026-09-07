# AAA2-027/028/035 — política crítica local

Data: 2026-09-05

Esta evidência cobre uma fatia sintética e storage-neutral da política de
resultado crítico. O módulo valida versão, referência de aprovação, vigência,
limiares de escalonamento e fallback; resolve destinatários ativos em ordem
determinística; e produz uma decisão de escalonamento com chave idempotente.

## Provas executadas

| Comando | Resultado |
| --- | --- |
| `npx vitest run src/server/application/critical-result-policy.test.ts` | PASS — 5 testes |
| `npx vitest run src/server/application/error-branches.test.ts` | PASS — 5 testes; liberação crítica incompleta continua `CRITICAL_POLICY_MISSING` e configuração completa permite a jornada sintética |
| `npm run typecheck` | PASS no recorte do módulo antes da edição relacional paralela; a execução global subsequente ficou temporariamente bloqueada por arquivos em edição pelo lane relacional |

## Limites

O runtime ainda usa variáveis de ambiente como fonte transitória da política e
o módulo não declara persistência clínica, rota administrativa, job durável,
lease/restart ou destinatário de plantão institucional. A política não é
considerada aprovada por existir no código. PostgreSQL, duas instâncias,
runbook e D-03 continuam necessários para aceitar AAA2-027/028/035.
