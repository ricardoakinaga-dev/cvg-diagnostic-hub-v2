# Runbooks de incidentes e degradação

**Status:** procedimento técnico local `IMPLEMENTED / PENDING D-05`; não é autorização de operação produtiva.

Este documento define a resposta mínima para incidentes do CVG Diagnostics Hub. A equipe deve registrar o `x-correlation-id`, horário UTC, versão do candidato, ambiente e operador. Não copiar payload clínico, credencial, cookie, token, connection string ou conteúdo de anexo para tickets ou logs.

## Regras de segurança

1. Preservar o estado e a evidência antes de reiniciar ou limpar filas.
2. Usar somente comandos aprovados para o ambiente identificado; nunca apontar smoke, restore ou reset para `127.0.0.1:5432` persistente sem uma decisão explícita.
3. Se a autorização, identidade, contexto do paciente ou integridade do resultado estiver incerta, interromper a ação clínica e usar o canal institucional de contingência.
4. Toda mudança operacional recebe uma correlação, um motivo e um plano de retorno.
5. O operador que executa o exercício deve ser diferente do autor do runbook no gate de release.

## Triagem comum

Capturar apenas:

- `GET /api/v1/livez`, `GET /api/v1/readyz` e `GET /api/v1/metrics` pelo canal administrativo;
- código de erro seguro, status HTTP, `x-correlation-id`, latência e timestamp;
- estado de deploy, migration version, profundidade/idade do outbox e disponibilidade do storage;
- impacto funcional agregado, sem nome de paciente, tutor, resultado ou anexo.

Classificação inicial:

| Classe | Sinal | Ação imediata |
| --- | --- | --- |
| P0 segurança clínica | possível vazamento, ação fora de escopo, resultado incorreto ou crítico sem destinatário | bloquear a jornada afetada, revogar sessões suspeitas, preservar audit e escalar para Segurança/Clínica |
| P1 disponibilidade | `/readyz` falha, banco/storage indisponível, outbox envelhecido ou erro sustentado | manter escrita clínica somente se o boundary declarar segurança; abrir incidente e executar o runbook específico |
| P2 experiência | reconnect storm, latência acima do orçamento ou falha visual localizada | habilitar fallback seguro, registrar correlação e acompanhar sem mascarar estado stale/degraded |

## Banco ou readiness indisponível

1. Confirmar `/livez` e `/readyz`; comparar o código seguro e a correlação.
2. Não repetir comandos clínicos manualmente sem `Idempotency-Key` e `expectedVersion` atuais.
3. Verificar pool, migration compatibility e alertas do banco sem imprimir `DATABASE_URL`.
4. Se o banco estiver indisponível, manter a aplicação em `NOT_READY`; não alternar para memória em produção.
5. Escalar para o procedimento de [backup e restore](BACKUP_RESTORE.md) somente com alvo descartável ou aprovado.
6. Validar por contagem, hash, audit, outbox, readiness e uma jornada sintética antes de reabrir tráfego.

Stop criteria: qualquer divergência, migration drift, autoridade ambígua, restore sem checksum ou jornada clínica não reproduzível mantém o tráfego bloqueado.

## Outbox atrasado ou dead-letter

1. Consultar `cvg_outbox_pending`, `cvg_outbox_oldest_age_seconds` e contadores de falha; não editar linhas diretamente. As duas métricas contam só entregas de notificação: eventos de domínio são histórico de replay do tempo real, não têm consumidor no worker e saem pela retenção (desde 07/10/2026).
2. Separar `PROCESSING` com lease ativo de `PENDING` elegível e `FAILED` dead-letter.
3. Confirmar `consumerType`, `routingKey`, correlação e tentativas; nunca reprocessar um evento em outro consumidor.
4. Validar o sink durável e sua confirmação antes de aumentar workers ou retry.
5. Para notificação crítica, usar o fallback institucional e registrar acknowledgement fora do sistema se a política aprovada exigir.
6. Após a recuperação, confirmar que a entrega é idempotente e que o estado clínico não foi duplicado.

## Storage, upload ou scanner AV indisponível

1. Marcar a operação como degradada e não liberar resultado que dependa de anexo não verificado.
2. Confirmar `scanStatus`, `uploadStatus`, claim ativo e quarantine; não conceder download privado por atalho.
3. Verificar endpoint aprovado, TLS, allowlist, timeout e segredo injetado pelo mecanismo autorizado.
4. Corrigir o serviço externo ou executar o procedimento de contingência aprovado; não trocar `STORAGE_MODE`/`STORAGE_SCAN_MODE` em produção para local.
5. Liberar somente após checksum, MIME/signature, scan `CLEAN`, vínculo e auditoria serem confirmados.

## Realtime degradado

1. Verificar `cvg_realtime_connection_rejections_total`, falhas de poll, closures e resyncs.
2. Tratar LISTEN/NOTIFY como wake-up; reler o estado durável e reautorizar o ator antes de exibir qualquer evento.
3. Se o cliente estiver lento, preservar backpressure e usar snapshot/polling bounded; nunca enviar payload clínico no notify.
4. Em reconnect, usar `Last-Event-ID` somente dentro da janela disponível e aceitar `resync` quando necessário.
5. Se a sessão for revogada, encerrar o stream e exigir novo login; não manter uma conexão “útil” por tolerância.

## Segurança ou autorização suspeita

1. Não tentar reproduzir com dados reais; usar fixture sintética e um ambiente isolado.
2. Revogar a sessão afetada, preservar audit/correlation e bloquear o endpoint até delimitar o escopo.
3. Confirmar que lista, busca, timeline, SSE, attachment, draft, versão e comando retornam boundary fail-closed.
4. Abrir revisão independente; nenhuma correção local substitui o parecer de Segurança, Privacidade ou Clínica.

## Fechamento do incidente

O incidente só pode ser fechado quando houver: causa ou limite documentado; evidência sanitizada; teste/regressão que detectaria a falha; impacto clínico avaliado; ação preventiva; owner e prazo; decisão explícita de reabrir tráfego, manter degradação ou fazer rollback. A ausência de logs por falha do logger não deve alterar a decisão: o boundary HTTP continua sendo a fonte da resposta e a auditoria durável permanece a fonte da ação clínica.

## Exercício local reproduzível

```text
npm run validate
npm run test:recovery
npm run test:perf
npm run security:scan
npm --silent run security:sbom > sbom.cdx.json
```

Esses comandos demonstram controles locais. Eles não provam RPO/RTO aprovado, failover do ambiente-alvo, restore de object storage/configuração/chaves, piloto ou autoridade de release.
