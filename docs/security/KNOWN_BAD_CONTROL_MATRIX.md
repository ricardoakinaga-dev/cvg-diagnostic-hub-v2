# Matriz de controles known-bad

**Status:** evidência automatizada local `PASS`; o sentinel de mutação Node 22 detecta 7/7 mutações catalogadas; revisão independente e execução em ambiente-alvo continuam pendentes.

Esta matriz registra entradas deliberadamente inválidas e a fronteira que deve rejeitá-las. Um teste verde significa que o comportamento negativo foi observado no working tree atual; não significa que a política institucional ou o ambiente de identidade/storage estejam aprovados.

| ID | Entrada known-bad | Boundary esperado | Evidência executável | Resultado local |
| --- | --- | --- | --- | --- |
| KB-001 | ator com paciente/setor diferente consulta patient, request, item, fila, busca, timeline ou workspace | `404 SCOPE_DENIED` ou resultado filtrado sem contagem/identificador indevido | [`read-models.test.ts`](../../src/server/application/read-models.test.ts), [`patient-workspace.test.ts`](../../src/server/application/patient-workspace.test.ts), [`scoped-reads-route.test.ts`](../../src/server/http/scoped-reads-route.test.ts) | PASS |
| KB-002 | ator sem a permissão/fase tenta cancelar, rejeitar, recolher, iniciar, revisar, invalidar ou liberar | comando rejeitado antes da mutação; estado, audit e outbox preservados | [`cancellation-policy.test.ts`](../../src/server/http/cancellation-policy.test.ts), [`workflow-commands.test.ts`](../../src/server/application/workflow-commands.test.ts), [`error-branches.test.ts`](../../src/server/application/error-branches.test.ts) | PASS |
| KB-003 | draft/result é atualizado com versão antiga, replay de outro ator ou executor peer | `STALE_VERSION`/`SCOPE_DENIED`; nenhuma sobrescrita ou resposta cacheada fora do escopo | [`result-access-security.test.ts`](../../src/server/application/result-access-security.test.ts), [`service.test.ts`](../../src/server/application/service.test.ts) | PASS |
| KB-004 | arquivo com MIME declarado PDF e assinatura/bytes incompatíveis, checksum errado ou sessão expirada | quarantine ou erro antes da finalização; download/release privado bloqueado | [`attachments.test.ts`](../../src/server/application/attachments.test.ts), [`malware-scanner.test.ts`](../../src/server/storage/malware-scanner.test.ts) | PASS |
| KB-005 | worker publica e cai antes de marcar o outbox; segundo worker repete a entrega | sink durável confirma a mesma chave natural sem duplicar delivery; lease antigo não conclui | [`outbox.test.ts`](../../src/server/operations/outbox.test.ts), [`postgres-store.integration.test.ts`](../../tests/postgres/postgres-store.integration.test.ts) | PASS local; efeito distribuído alvo pendente |
| KB-006 | mensagem `PROCESSING` ou `FAILED` aparece na janela de replay SSE | não deve ser apresentada como evento confirmado; `PENDING`/`PROCESSED` são relidos e autorizados | [`realtime-stream.test.ts`](../../src/server/observability/realtime-stream.test.ts) | PASS local |
| KB-007 | endpoint de scanner com IP/host não aprovado, credencial na URL, fragmento ou redirect | configuração rejeitada; fetch sem seguir redirect; nenhum segredo em erro/log | [`malware-scanner.test.ts`](../../src/server/storage/malware-scanner.test.ts) | PASS local; egress/DNS real pendente |
| KB-008 | corpo/header/correlation contém newline, ID arbitrário, payload clínico ou segredo | schema/label/log boundado e redigido | [`request-body.test.ts`](../../src/server/http/request-body.test.ts), [`metrics.test.ts`](../../src/server/observability/metrics.test.ts), [`structured-logger.test.ts`](../../src/server/observability/structured-logger.test.ts) | PASS |

## Regra de revalidação

Qualquer mudança em autorização, route manifest, estado, storage, outbox, realtime ou logger reabre os casos correspondentes. A matriz não autoriza reduzir o denominador, substituir integração PostgreSQL por memória ou transformar a evidência local em aprovação clínica/produção.

## Sentinel de mutação

O [controle de mutação](MUTATION_CONTROLS.md) injeta uma falha em cada fronteira abaixo e exige que a suíte focal falhe: autorização (`MC-AUTH-001`), versão otimista (`MC-VERSION-001`), migration (`MC-MIGRATION-001`), upload (`MC-UPLOAD-001`), outbox (`MC-OUTBOX-001`), realtime (`MC-REALTIME-001`) e recovery (`MC-RECOVERY-001`). O resultado atual é **7/7 detectadas**. A abrangência não é mutation score global e não fecha os gates humanos ou de ambiente-alvo.
