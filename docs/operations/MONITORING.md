# Monitoramento externo de produção

A pilha em `docker-compose.monitoring.yml` roda em **outro servidor, com energia e conexão independentes do Hub**. Prometheus coleta o Hub por HTTPS, o servidor pelo agente de VPN com TLS mútuo e o acesso externo pelo Blackbox Exporter; Alertmanager envia cada alerta operacional a dois destinos configurados, titular e reserva. O heartbeat `CvgMonitoringWatchdog` segue para um terceiro serviço independente: esse serviço deve avisar o plantão se deixar de receber o heartbeat, cobrindo também a perda do servidor de monitoramento.

O código e os testes locais não constituem aceite de um plantão. A entrada em produção exige URLs e credenciais reais, responsáveis nomeados, instalação nos servidores e entrega **com confirmação humana** ao titular e à reserva. A auditoria local usa apenas receptores descartáveis; nenhum alerta real é enviado por validação de configuração.

## Fontes e alertas

| Fonte real | Coleta | Falhas cobertas |
| --- | --- | --- |
| `/api/v1/metrics` do Hub | HTTPS com bearer em arquivo | indisponibilidade, 5xx, readiness, filas, crítico, quarentena, memória e expurgo pendente |
| Host Linux | Node Exporter, endpoint na VPN com certificado de cliente | perda do servidor, disco de dados/WAL abaixo de 15% livre, erros do agente |
| Estado de containers | coletor local via `docker ps/inspect`, projeto exato | app, worker, PostgreSQL, backup, offsite, storage, ClamAV e scanner ausentes/parados |
| Healthcheck de ClamAV e scanner | `docker inspect .State.Health` | AV indisponível mesmo sem uploads; não depende de `/readyz` |
| Heartbeat real do worker | leitura do arquivo no container via `docker exec` | worker ocioso parado ou com erro persistente, mesmo com outbox vazio |
| Artefatos existentes no volume de backup | nomes finalizados, tamanho e mtime | dump e backup base ausentes ou mais antigos que 48 h; `.partial` não conta |
| `offsite-status.json` | último sucesso e resultado da tentativa | envio externo desabilitado, falhando ou sem sucesso há 15 min |
| `pg_stat_archiver` e `pg_wal/archive_status` | SQL somente de metadados, socket local do container | falhas de arquivamento, segmentos `.ready` presos por mais de 10 min |
| Sonda HTTPS independente | Blackbox Exporter, `/api/v1/livez` | acesso externo e certificado com menos de 14 dias até expirar |
| Prometheus/Alertmanager | métricas dos próprios serviços | falha de entrega para Alertmanager ou para receptor; reserva recebe independentemente do titular |
| Watchdog | alerta permanente repetido a cada minuto | serviço independente detecta ausência do monitor; configurar timeout de 3 minutos no receptor |

`scripts/monitoring-host-collector.mjs` publica métricas atômicas em `cvg.prom`; não publica ambiente, senhas, nomes de arquivos clínicos ou conteúdo do banco. Roda sob timer local com privilégio para inspecionar Docker e ler o volume de backup. O Node Exporter não recebe socket Docker nem acesso direto ao volume de backup. O coletor exporta zero/erro quando a leitura falha; ausência ou atraso de sua própria atualização gera alerta. O arquivador ocioso não causa falso alarme: o alerta usa segmentos pendentes e falhas, em vez de exigir WAL novo quando não há escrita.

Os limites são pontos de partida: alinhe intervalos e alertas à política aprovada do hospital. Alertas de críticos devem chegar ao responsável clínico e seu substituto por meio do roteamento do receptor, além da operação de TI. Nenhum payload contém paciente ou narrativa clínica. Ver [runbooks](INCIDENT_RUNBOOKS.md), [backup e restore](BACKUP_RESTORE.md) e [notificações e críticos](../spec/NOTIFICATIONS.md).

## Configuração privada

Copie `.env.monitoring.example` para arquivos fora do Git, um por host. No monitor externo, preencha `MONITOR_ROLE=external`, `MONITOR_HUB_URL`, `MONITOR_AGENT_URL`, `MONITOR_CONFIG_DIR`, `MONITOR_SECRETS_DIR`, `MONITOR_DATA_DIR`, `MONITOR_UID` e `MONITOR_GID`. Use um usuário dedicado sem privilégio e diretórios pertencentes a esse UID/GID: configuração/segredos `0700`, arquivos `0600`, dados `0700`. Crie previamente os subdiretórios de dados `prometheus` e `alertmanager`; o Compose não deve criar diretórios como root por falta de um bind mount.

No diretório de segredos do **monitor externo**, instale:

- `metrics_scrape_token`: o token real do endpoint do Hub, com pelo menos 32 caracteres;
- `agent_ca.pem`, `agent_client_cert.pem`, `agent_client_key.pem`: CA do agente e certificado de cliente autorizado com sua chave; chave privada da CA não é distribuída;
- `primary_webhook_url` e `primary_webhook_token`: destino do titular e bearer com pelo menos 32 caracteres;
- `reserve_webhook_url` e `reserve_webhook_token`: destino da reserva e seu bearer;
- `watchdog_webhook_url` e `watchdog_webhook_token`: receptor independente do heartbeat;
- `hub_ca.pem`, somente se o Hub usa CA privada; nesse caso configure `MONITOR_HUB_PRIVATE_CA=true`;
- `webhook_ca.pem`, somente se os receptores usam CA privada; configure `MONITOR_WEBHOOK_PRIVATE_CA=true`.

Cada receptor deve aceitar o formato de [webhook do Alertmanager](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config), com autenticação bearer e HTTPS validado. Use um gateway institucional compatível ou um adaptador aprovado para o provedor escolhido. TLS, autenticação e confirmação do receptor precisam ser testados no destino real. O código impede URLs idênticas, HTTP, valores de exemplo e credenciais curtas; URLs diferentes no mesmo provedor continuam compartilhando sua falha. A independência de hosts, provedores, canais e responsáveis é um critério operacional a comprovar no alvo.

No **host do Hub**, use `MONITOR_ROLE=agent`, `MONITOR_AGENT_BIND_IP` com o IPv4 da VPN, `CVG_MONITOR_PROJECT` com o projeto real, `CVG_MONITOR_TEXTFILE_DIR=/var/lib/cvg-monitoring/textfile`, diretórios próprios de configuração/segredos e UID/GID do usuário dedicado. Seus segredos são apenas `agent_ca.pem`, `agent_server_cert.pem` e `agent_server_key.pem`: certificado de servidor com SAN correspondente ao hostname de `MONITOR_AGENT_URL`, certificado de cliente permitido pela CA e chaves distintas. A CA pode ser emitida pela PKI do hospital; mantenha validade, cadeia, revogação e renovação sob responsabilidade nomeada.

O endereço do agente deve resolver para a VPN e ser alcançável pelo servidor externo. O gerador rejeita bind em endereço público, loopback ou wildcard; o Compose publica somente `${MONITOR_AGENT_BIND_IP}:9100`. Restrinja também o firewall ao IP VPN do monitor; uma rede privada por si só não substitui essa regra. O endpoint exige TLS e certificado de cliente válido.

## Instalação

Os comandos abaixo usam o env correspondente ao host e não enviam notificações por si mesmos. Carregue as variáveis do arquivo institucional usando o procedimento de ambiente do hospital. As variáveis contêm caminhos e endereços; tokens e chaves ficam nos arquivos privados.

```bash
# Em cada host, depois de fornecer seu ambiente e os arquivos privados:
node scripts/monitoring-config.mjs
node scripts/monitoring-config.mjs --check

# No host do Hub: após revisar caminhos fixos da unit para a instalação local.
sudo install -d -m 0755 /var/lib/cvg-monitoring/textfile
sudo install -m 0644 deploy/observability/cvg-host-collector.service /etc/systemd/system/
sudo install -m 0644 deploy/observability/cvg-host-collector.timer /etc/systemd/system/
# A unit lê /etc/cvg-hub/monitor-agent.env e usa /opt/cvg-diagnostic-hub-v2 e /usr/bin/node.
# Alinhe esses caminhos com a instalação real antes de ativar.
sudo systemctl daemon-reload
sudo systemctl enable --now cvg-host-collector.timer
sudo systemctl start cvg-host-collector.service
docker compose -p cvg-monitor-agent -f docker-compose.monitoring-agent.yml --env-file /etc/cvg-hub/monitor-agent.env config --quiet
docker compose -p cvg-monitor-agent -f docker-compose.monitoring-agent.yml --env-file /etc/cvg-hub/monitor-agent.env up -d

# No monitor independente: valide os arquivos e então suba os receptores configurados.
docker compose -p cvg-monitor -f docker-compose.monitoring.yml --env-file /etc/cvg-hub/monitor.env config --quiet
docker compose -p cvg-monitor -f docker-compose.monitoring.yml --env-file /etc/cvg-hub/monitor.env up -d
```

O startup validator executa novamente `monitoring-config.mjs --check`: certificados devem estar vigentes, chave/certificado precisam corresponder, segredos devem ser arquivos privados e a configuração existente deve coincidir com o ambiente atual. A configuração usa os recursos oficiais de [Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/), [Node Exporter](https://github.com/prometheus/node_exporter#textfile-collector) e [Blackbox Exporter](https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md). As interfaces de Prometheus e Alertmanager ficam em loopback, acessíveis por túnel SSH/VPN; o Blackbox não publica porta. Não exponha seus endpoints à internet. Escaneie as imagens fixadas em versão e a imagem de validação antes de instalar; registre os digests usados e o resultado do scan no candidato de produção.

## Verificação e aceite

`npm run observability:check` verifica regras de aplicação e infraestrutura e executa os testes de sinais positivos e negativos com `promtool`. Para rodar sem Docker, aponte `PROMTOOL` para o binário oficial. `node --test scripts/monitoring.test.mjs` testa coleta e recusa de configurações inválidas; com `PROMTOOL` e `AMTOOL` oficiais também valida a configuração gerada e as rotas titular/reserva/watchdog. O teste opcional de entrega usa `ALERTMANAGER_BIN` e receptores HTTPS somente em loopback; continua sem envio real.

No ambiente do hospital, antes do piloto:

1. Confira targets `cvg-hub`, `cvg-host`, `cvg-https`, `cvg-prometheus` e `cvg-alertmanager` como UP; valores de backup/base/offsite, heartbeat, WAL e disco devem coincidir com a inspeção independente. Confirme que conexão sem certificado no agente é recusada e que sua porta está inacessível fora da VPN.
2. Em homologação descartável, pare worker com outbox vazio, ClamAV/scanner, PostgreSQL e app; interrompa envio externo, arquivamento de WAL e coleta local; use limiares de disco e TLS de teste. Cada alerta deve disparar e resolver conforme a condição, com recebimento e confirmação registrados pelos dois responsáveis. Não altere limites de produção nem pare serviços clínicos para esse teste.
3. Desligue o host de homologação inteiro: o monitor externo deve continuar vivo e entregar o alerta de host e HTTPS. Indisponibilize o primeiro receptor e comprove entrega pela reserva; depois simule a perda do monitor e comprove que o receptor de watchdog aciona o plantão após a ausência do heartbeat.
4. Registre ambiente, versão/digest, horário, sinal real, alerta, destinatários, confirmação, duração, resolução e responsável. Sem essa evidência de ponta a ponta, a pendência operacional permanece aberta.

Para os alertas de base/dump de 48 h e certidão de 14 dias, uma configuração de regra temporária no ambiente descartável acelera o ensaio; restaure e valide o arquivo original depois. A disponibilidade do monitor, sua retenção, atualizações e o serviço de watchdog também entram no plano de backup e manutenção do hospital.
