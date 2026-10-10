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

### Erros do armazenamento por entidade (migration 015)

- `POSTGRES_ENTITY_STATE_DIVERGED:<coleção|removal|upsert>` numa escrita: as linhas de `cvg_runtime_entities` não correspondem ao estado que o processo tinha sob a trava. A transação é desfeita inteira. Uma escrita manual fora do app costuma ser a causa. Pare as escritas manuais e reinicie o processo, que relê todas as entidades. Se o erro voltar, trate como divergência: tráfego bloqueado, comparação com o backup e correção para frente.
- `POSTGRES_ENTITY_KEY_DUPLICATE` ou `POSTGRES_ENTITY_KEY_INVALID`: um comando produziu duas entidades com a mesma chave, ou uma sem `id`. É defeito de código: abra incidente com a correlação; o estado persistido não muda.
- `ENTITY_CUTOVER_*` no `migrate`: a 015 recusou o snapshot (coleção que não é array, entidade sem chave, chave duplicada ou cópia diferente da origem). Nada foi aplicado. Corrija o dado no banco 014 preservado e rode de novo.
- `FATAL ERROR ... heap out of memory` no `app` ou no `worker`: o heap é pequeno para o volume atual; ajuste conforme o [DEPLOYMENT §6.6](DEPLOYMENT.md).

## Outbox atrasado ou dead-letter

1. Consultar `cvg_outbox_pending`, `cvg_outbox_oldest_age_seconds` e contadores de falha; não editar linhas diretamente. As duas métricas contam só entregas de notificação: eventos de domínio são histórico de replay do tempo real, não têm consumidor no worker e saem pela retenção (desde 07/10/2026).
2. Separar `PROCESSING` com lease ativo de `PENDING` elegível e `FAILED` dead-letter.
3. Confirmar `consumerType`, `routingKey`, correlação e tentativas; nunca reprocessar um evento em outro consumidor.
4. Validar o sink durável e sua confirmação antes de aumentar workers ou retry.
5. Para notificação crítica, usar o fallback institucional e registrar acknowledgement fora do sistema se a política aprovada exigir.
6. Após a recuperação, confirmar que a entrega é idempotente e que o estado clínico não foi duplicado.

## WhatsApp do crítico (PROD-402)

O WhatsApp é redundante: o alerta do Hub e a confirmação continuam valendo. Nunca procure o número de alguém no banco nem nos logs; ele não aparece em auditoria, outbox ou métricas.

1. Ver o campo `whatsapp` das notificações críticas e os eventos `CriticalAlertWhatsApp*` na auditoria.
2. Dead letters de rota `notification.whatsapp` (`lastError`):
   - `WHATSAPP_API_190`: token expirado ou revogado. Gerar um token novo, atualizar `WHATSAPP_ACCESS_TOKEN`, reiniciar o worker e reprocessar.
   - `WHATSAPP_API_132001` ou `132015`: template inexistente, não aprovado ou pausado. Corrigir na Meta antes de reprocessar.
   - `WHATSAPP_API_132000`: o template não tem exatamente um parâmetro no corpo e um no botão.
   - `WHATSAPP_TIMEOUT` ou `WHATSAPP_NETWORK`: conferir a saída para `graph.facebook.com:443`.
3. `FAILED` com `WHATSAPP_API_131026` não vai para o dead letter: o número não usa WhatsApp. Peça à pessoa para corrigir o número em **Minha conta**.
4. Webhook recusando (401 em `/api/v1/webhooks/whatsapp`): conferir se `WHATSAPP_APP_SECRET` é o app secret atual. Um 404 indica canal desligado ou segredo ausente.
5. O crítico não escalou:
   - conferir se o worker tem a política (`CRITICAL_POLICY_ENABLED`, `VERSION`, `APPROVAL_REF`, `APPROVED_AT` e os limiares);
   - procurar `critical.escalation` ou `critical.escalation_error` no log do worker;
   - ver os eventos `CriticalResultEscalated` da notificação do solicitante. A regra `NONE` quer dizer que ninguém estava de plantão (no setor ou no hospital) nem gerenciando o setor; nesse caso a administração recebeu o alerta operacional (runbook "Crítico sem confirmação ou sem destinatário").
6. Para desligar o canal: `WHATSAPP_ENABLED=false` no app e no worker. Os alertas na fila são encerrados como `SKIPPED/CHANNEL_DISABLED`, e o crítico segue só no Hub.

## Crítico sem confirmação ou sem destinatário

Dono: direção clínica / gestor do setor solicitante. A TI apoia, não confirma o resultado. Nunca copie valor, paciente ou tutor para o incidente; o protocolo da solicitação basta.

1. `CvgCriticalUnacknowledged` (`cvg_critical_unacknowledged > 0`): um crítico subiu pelo menos um degrau da escada e ninguém confirmou. Em **Notificações › Crítica** do solicitante e dos escalonados, ver quem já recebeu (`escalation.level`, `whatsapp`); ligar para o solicitante ou para o plantão do setor; quem abrir o resultado confirma no Hub e a escada para.
2. `CvgCriticalUnreachable` (`cvg_critical_unreachable > 0`): um degrau devido não alcançou ninguém clínico. Os ADMIN ativos receberam a notificação administrativa "Crítico sem confirmação e sem destinatário" (protocolo e setor) e o worker logou `critical.escalation_unreachable`; a auditoria tem `CriticalResultUnreachable` na notificação do solicitante. Acionar o setor por telefone, pedir que um profissional com acesso confirme no Hub e, em seguida, corrigir a causa:
   - ninguém de plantão no setor solicitante: marcar **Colocar no plantão** em um profissional do setor (ou de outro setor: sem plantonista próprio, **todos** os plantonistas do hospital que consigam abrir o resultado entram de uma vez no degrau `ON_CALL`; por isso a prontidão pede plantonista em cada setor solicitante, para que essa reserva seja exceção);
   - gestor sem o setor do exame: incluir o setor em **Setores gerenciados**;
   - solicitante desativado ou sem acesso: ver `CriticalResultEscalated` com `rule NONE` e a regra seguinte da política.
   O alerta é um por resultado; ele sai quando alguém confirma a versão. Não fecha sozinho.
3. `CvgCriticalReadinessDegraded` (prontidão): a política está ativa, mas falta canal redundante aceito ou há setor solicitante sem plantonista por 15 minutos. Conferir **Sistema › Resultado crítico** (ou `GET /api/v1/critical-results/readiness`): política (`CRITICAL_POLICY_*` no app e no worker), canal (`WHATSAPP_ENABLED=true` ou o aceite nominal do hospital em `CRITICAL_POLICY_IN_APP_ONLY_APPROVAL_REF`), plantonistas por setor e administradores ativos. A prontidão informa; a liberação de um crítico nunca é bloqueada por ela.
4. Registrar no incidente: protocolo, horários dos degraus (`CriticalResultEscalated`), quem confirmou e a correção aplicada ao plantão ou à política.

## Storage, upload ou scanner AV indisponível

1. Marcar a operação como degradada e não liberar resultado que dependa de anexo não verificado.
2. Confirmar `scanStatus`, `uploadStatus`, claim ativo e quarantine; não conceder download privado por atalho.
3. Verificar endpoint aprovado, TLS, allowlist, timeout e segredo injetado pelo mecanismo autorizado.
4. Corrigir o serviço externo ou executar o procedimento de contingência aprovado; não trocar `STORAGE_MODE`/`STORAGE_SCAN_MODE` em produção para local.
5. Liberar somente após checksum, MIME/signature, scan `CLEAN`, vínculo e auditoria serem confirmados.

**Anexo em quarentena (PROD-308).** Sinal: alerta `CvgAttachmentQuarantined` (métrica `cvg_attachment_scans_total{status="QUARANTINED"}`) ou o evento `attachment.quarantined` no log do `app` (ids do anexo e da versão do resultado, MIME declarado e detectado; nunca o nome do arquivo). O que já aconteceu sozinho: o objeto ficou no bucket sob a chave reivindicada (`attachments/<resultId>/...claim-<token>`), com `scanStatus=QUARANTINED`; ele não pode ser finalizado (`422 ATTACHMENT_QUARANTINED`) nem baixado (`404`), e quem enviou viu a recusa na tela. **Dono da quarentena:** a função de segurança da informação da TI do hospital (nome e contato no modelo de escala, PROD-516); até a escala existir, o responsável pelo incidente. Passos: (1) registrar o incidente com `attachmentId`, `resultVersionId` e quem enviou (auditoria da sessão de upload); (2) perguntar ao profissional a origem do arquivo e orientar a não reenviar de outra forma; (3) no modo on-prem, confirmar as assinaturas do ClamAV (`docker compose ... exec clamav sigtool --info /var/lib/clamav/daily.cld`) e, se houver suspeita de falso positivo, reanalisar o conteúdo por outro meio **fora** do servidor; (4) o objeto em quarentena só é removido pelo dono, pelo prefixo registrado, nunca "liberado": um anexo legítimo é reenviado limpo pelo profissional; (5) fechar o incidente anotando a decisão. O scanner devolve `FAILED` (503) quando o clamd não responde: o upload recebe `STORAGE_UNAVAILABLE` e nada é guardado.

## Backup falho ou cópia externa parada

Sinais: container `offsite` `unhealthy`; `check-offsite.sh` com código diferente de zero; `lastResult` diferente de `ok` em `/backups/offsite-status.json`; eventos `backup.failed`, `basebackup.failed` ou `wal.archive_failed` nos logs; `pg_stat_archiver.failed_count` crescendo; volume do banco ou `pg_wal` enchendo. Cada minuto parado é um minuto a menos do orçamento de RPO (15 min, D2).

1. Verificar e anotar o estado, sem imprimir credenciais:
   `docker compose -f docker-compose.prod.yml --env-file .env.production exec offsite sh /opt/backup/check-offsite.sh` (e `cat /backups/offsite-status.json`), `docker compose ... logs --tail 100 offsite backup`.
2. Arquivamento local parado (`pg_stat_archiver.last_failed_time` recente): `docker compose ... exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select last_archived_wal, last_archived_time, failed_count, last_failed_wal from pg_stat_archiver"`. Causas comuns: volume `cvg-wal-archive` cheio (`df`, libere dumps antigos ou aumente o disco; o PostgreSQL retém o WAL e tenta de novo sozinho), segmento diferente já existente (`different_segment_exists`: dois clusters no mesmo arquivo, parar e escalar), permissão do diretório. Enquanto falha, o `pg_wal` cresce: acompanhe o disco do banco.
3. Cópia externa parada com arquivamento local normal: destino inacessível, credencial vencida ou rotacionada, cota cheia, relógio errado. Testar com `docker compose ... run --rm --no-deps offsite sh /opt/backup/rclone-with-secrets.sh lsd offsitecrypt:` (o helper carrega os segredos em arquivo e define o remoto cifrado; `destination is not a crypt remote` em `reason` significa que o destino deixou de ser o `crypt`, D-051). Corrigir a causa; o serviço retoma sozinho e o `healthcheck` volta a `healthy` no próximo ciclo (`--once` força um: `docker compose ... run --rm --no-deps offsite --once`; o entrypoint do serviço já é o script, por isso o argumento é só `--once`).
4. Backup base ou dump falhando (`basebackup.failed`): conferir `POSTGRES_BACKUP_PASSWORD` (papel `cvg_backup` existe? `\du`) e a conexão de replicação; o `backup` repete em até 15 min. Tire um backup manual: `docker compose ... run --rm --no-deps backup --once`.
5. `offsite.refused` (`reason` em `/backups/offsite-status.json`): `/backups` está vazio, ausente ou sem dump/backup base não vazio mais novo que `OFFSITE_MAX_BACKUP_AGE_SECONDS` (volume errado, `backup` parado, disco cheio). O destino não é alterado (o envio nunca apaga); corrija o `backup` (passo 4) e o próximo ciclo volta a `ok`. Com `reason` `bucket source unreachable` (PROD-514, bucket de anexos na cópia externa): o `offsite` não conseguiu listar `OFFSITE_BUCKET_SOURCE` (MinIO parado, credencial trocada ou nome de bucket errado); WAL e dumps ainda saíram, os objetos não. Teste com `docker compose ... exec offsite sh /opt/backup/rclone-with-secrets.sh size "$OFFSITE_BUCKET_SOURCE"` e confira `storage` (`healthy`?), o usuário `OFFSITE_STORAGE_ACCESS_KEY` e o arquivo `offsite_storage_secret_key` (o `storage-iam` reaplica a senha a cada `up`).
6. Enquanto a cópia externa estiver parada, registrar o intervalo sem cobertura (do último `lastShippedAt` até o fim da correção) como exposição de RPO e informar o responsável; se o servidor puder ser perdido nesse intervalo, considere copiar `cvg-backups` e `cvg-wal-archive` manualmente para outra mídia.
7. Fechamento: `check-offsite.sh` com código 0, `walSegments` crescendo no status e um registro no incidente do intervalo exposto. O restore em si segue [BACKUP_RESTORE.md §4](BACKUP_RESTORE.md#4-runbook-de-restore).

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

## Tentativas de login distribuídas

Alerta `CvgLoginDistributedAttempts` / log `security.login_distributed_attempts` / auditoria `LoginDistributedAttemptsDetected` (PROD-203, PROD-517). Significa que **uma conta** acumulou `LOGIN_ACCOUNT_SIGNAL_THRESHOLD` (padrão 20) senhas erradas, somadas de vários clientes, em `LOGIN_ACCOUNT_SIGNAL_WINDOW_MS` (padrão 15 min). É um sinal, não um bloqueio: ninguém foi impedido de entrar e o backoff por par não mudou (D-021).

1. Leia o log: `accountId` (pseudonimizado), `attempts` e `distinctClients`. Muitos clientes distintos sugere tentativa distribuída (password spraying ou botnet); um só cliente costuma ser alguém digitando errado. O `accountId` se reconstrói com `sha256(SESSION_SECRET + e-mail em minúsculas)` (16 primeiros hex) para confirmar de qual conta se trata; não procure o e-mail em log.
2. Veja a auditoria da mesma conta e as sessões recentes (aba Sistema): houve login bem-sucedido logo depois dos erros? Se sim, trate como possível comprometimento: gere um link de redefinição (`Gerar link de redefinição`, que também encerra as sessões da conta) e entregue pelo canal combinado, confirmando com a pessoa.
3. Se o padrão continuar, confirme no proxy os endereços de origem (`X-Forwarded-For` confiável, DEPLOYMENT §5.1) e bloqueie-os na borda; não bloqueie a conta no Hub, pois isso trancaria o dono para fora.
4. Aumente o limiar só se o alerta for ruído comprovado (estações atrás do mesmo NAT). Registre o incidente conforme o fechamento abaixo.

## Fechamento do incidente

O incidente só pode ser fechado quando houver: causa ou limite documentado; evidência sanitizada; teste/regressão que detectaria a falha; impacto clínico avaliado; ação preventiva; owner e prazo; decisão explícita de reabrir tráfego, manter degradação ou fazer rollback. A ausência de logs por falha do logger não deve alterar a decisão: o boundary HTTP continua sendo a fonte da resposta e a auditoria durável permanece a fonte da ação clínica.

## Exercício local reproduzível

```text
npm run validate
npm run test:recovery
npm run test:perf
npm run security:scan
npm --silent run security:sbom > sbom.cdx.json
npm run restore:drill     # banco + anexos perdidos e restaurados da cópia externa, com reconciliação (BACKUP_RESTORE §4.6)
npm run outage:drill      # PostgreSQL, MinIO, ClamAV, worker e app indisponíveis, um a um, com as regras do Prometheus disparando
```

`scripts/outage-drill.sh` (D-062) sobe a pilha de produção inteira (overlays `prod + onprem + secrets`, borda HTTP em loopback) mais um Prometheus com as regras de `deploy/observability/alerts.yml` lendo o `/api/v1/metrics` real, e ensaia os runbooks deste documento: worker parado (entrega enfileirada pelo outbox da aplicação, `cvg_outbox_oldest_age_seconds` passa de 300 s, `CvgOutboxStalled` dispara e resolve quando o worker volta), ClamAV parado (adaptador `scanner` fica não saudável; readiness continua, nenhum anexo é liberado sem verificação), MinIO e PostgreSQL parados (`/readyz` 503, `cvg_readiness_failures` sobe, `CvgHubReadinessFailing` dispara, recuperação ao voltar) e app parado (`up == 0`, `CvgHubScrapeDown` após 2 min). O JSON final traz, por cenário, segundos até detectar, até o alerta e até recuperar. Donos e roteamento dos alertas continuam a cargo do hospital (PROD-516).

Evidência medida em 10/10/2026 (laboratório local, `npm run outage:drill`, Prometheus v3.15 com `scrape_interval`/`evaluation_interval` de 15 s, regras com os `for` de produção):

| Cenário | Sinal observado | Regra | Até detectar | Até o alerta | Até recuperar |
| --- | --- | --- | --- | --- | --- |
| worker parado (1 entrega enfileirada pelo outbox da aplicação) | `cvg_outbox_oldest_age_seconds` 606 s no disparo | `CvgOutboxStalled` (`> 300 s for 5m`) | — | 612 s depois da fila | entrega 12 s após o worker voltar; alerta resolvido no ciclo seguinte |
| ClamAV parado | healthcheck do `scanner` (`/health` faz `PING` no clamd) `unhealthy`; `/readyz` continua 200 | — (nenhum anexo é liberado sem verificação; upload recusado) | 53 s | — | 19 s |
| MinIO parado | `/readyz` 503, `cvg_readiness_failures` sobe | `CvgHubReadinessFailing` | 0 s | 37 s | 3 s |
| PostgreSQL parado | `/readyz` 503, `cvg_readiness_failures` sobe | `CvgHubReadinessFailing` (ainda ativo da janela de 10 min do cenário anterior) | 0 s | 0 s | 3 s |
| app parado | `up{job="cvg-hub"} == 0` | `CvgHubScrapeDown` (`for 2m`) | 9 s | 127 s | 6 s |

Ensaio completo em 851 s. O tempo até `CvgOutboxStalled` (~10 min) é o desenho da regra: idade da mensagem acima de 300 s **e** 5 min de `for`; quem precisar de reação mais rápida muda a regra, não o worker. Limites: borda HTTP em loopback (o TLS real é outro ensaio), `cvg_readiness_failures` só cresce quando alguém chama `/readyz` (aqui, o próprio ensaio e o healthcheck do app), e o roteamento até um dono nomeado não existe até o PROD-516.

Esses comandos demonstram controles locais. Eles não provam RPO/RTO aprovado, failover do ambiente-alvo, restore de object storage/configuração/chaves, piloto ou autoridade de release.
