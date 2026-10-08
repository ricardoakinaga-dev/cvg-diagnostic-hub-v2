# Deploy de produção

Para a instância isolada instalada nesta máquina, acesso, manutenção e
evidências estão em [LOCAL_INSTALLATION.md](LOCAL_INSTALLATION.md).

**Knowledge status:** `FACT` para os comandos, verificados em 01/10/2026 contra um stack local em modo produção (`NODE_ENV=production`, PostgreSQL, S3 compatível, proxy TLS). `DECISION` para a topologia. Este runbook **não** aprova uso clínico: os gates humanos de [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) continuam valendo.

## 1. Topologia

```
Internet ──TLS──> proxy (Caddy) ──HTTP + X-Cvg-Proxy-Secret──> app (Next.js, imagem runner)
                                                                 │
                         worker (outbox, imagem ops) ──────────> PostgreSQL 16
                         migrate / bootstrap (one-shot, ops) ──> PostgreSQL 16
app ──> S3 compatível (anexos)      app ──HTTPS──> antivírus externo
```

| Componente | Imagem / origem | Papel |
| --- | --- | --- |
| `proxy` | `caddy:2-alpine` + [`deploy/Caddyfile`](../../deploy/Caddyfile) | TLS automático, injeta o segredo compartilhado, descarta `X-Forwarded-For` vindo do cliente. Único serviço com porta publicada. |
| `app` | `Dockerfile` target `runner` | Servidor web. Usuário `node`, sem npm no runtime, healthcheck em `/livez` + `/readyz`. |
| `worker` | `Dockerfile` target `ops` | Entrega durável do outbox (`OUTBOX_SINK=postgres`). |
| `migrate` | target `ops` | Aplica migrations; o `app` e o `worker` só sobem depois dele terminar com sucesso. |
| `bootstrap` | target `ops`, profile `bootstrap` | Cria o primeiro ADMIN em banco vazio. Recusa banco já inicializado. |
| `postgres` | `postgres:16-alpine` | Pode ser trocado por instância gerenciada ajustando `DATABASE_URL`. |

Armazenamento S3 e antivírus são **serviços externos obrigatórios**: em produção o runtime recusa `STORAGE_MODE=local` e `STORAGE_SCAN_MODE=local`, e exige scanner em HTTPS com host na allowlist.

## 2. Pré-requisitos

1. Host com Docker Engine e Compose v2; DNS de `APP_DOMAIN` apontando para o host; portas 80/443 liberadas (ACME).
2. Bucket S3 criado (ou `npm run storage:init` contra endpoint estilo MinIO).
3. Endpoint do antivírus com API key, respondendo `{"status":"CLEAN"|"QUARANTINED"|"FAILED","detectedMime":...}`.
4. `.env.production` criado a partir de [`.env.production.example`](../../.env.production.example) com valores do secret manager. O arquivo é ignorado pelo git.

O `/readyz` falha (503) em produção, antes de tocar no banco, se `SESSION_SECRET` ou `TRUST_PROXY_SHARED_SECRET` tiverem menos de 32 caracteres ou se `TRUST_PROXY` não for `true`.

## 3. Primeiro deploy

Preencha o `.env.production` com **quatro segredos diferentes** de banco e aplicação: `POSTGRES_PASSWORD` (papel administrativo, usado só pelo `migrate`), `POSTGRES_MIGRATION_PASSWORD` (DDL), `POSTGRES_RUNTIME_PASSWORD` (app e worker) e `SESSION_SECRET`.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production --profile bootstrap run --rm bootstrap
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

O `migrate` (`scripts/db-roles.ts`) faz tudo o que o banco precisa, sem passo manual: cria os papéis `cvg_migrator` e `cvg_runtime` (e troca suas senhas se você as girar), entrega o banco, o schema e todos os objetos ao `cvg_migrator`, aplica as migrations e dá ao `cvg_runtime` só DML (sem DDL, e só `INSERT`/`SELECT` em `audit_events`). O `app`, o `worker` e o `backup` conectam como `cvg_runtime` e **não recebem** as credenciais de DDL nem a administrativa; só o `migrate` as tem. Funciona igual num banco novo e num banco que foi criado antes com um único superusuário.

**Primeiro acesso do ADMIN (PROD-202).** O caminho recomendado é deixar `BOOTSTRAP_ADMIN_PASSWORD` **vazio**. O `bootstrap` cria o ADMIN sem senha utilizável (hash aleatório) e imprime, uma única vez, uma linha como `{"event":"bootstrap.completed","adminId":"...","resetUrl":"https://<APP_DOMAIN>/reset-password?token=...","expiresAt":"..."}`. Abra o `resetUrl` no navegador antes de `expiresAt` (`PASSWORD_RESET_TTL_MS`, padrão 60 min) e defina a senha: o link vale uma única vez, só o seu hash fica no banco e o primeiro login é feito com a senha nova. Se o link expirar, emita outro pelo comando de emergência (somente operador, exige a credencial do banco, é auditado como `PasswordResetLinkIssued` com `source: CLI`; qualquer usuário ativo, de qualquer perfil, substitui o link anterior e tem as sessões encerradas): `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps worker node_modules/.bin/tsx scripts/password-reset-link.ts --email <email>`. Ele imprime `{"event":"password_reset_link.issued","userId":"...","resetUrl":"...","expiresAt":"..."}` e sai com código 1 para usuário inexistente ou inativo. Quem prefere definir a senha no ambiente ainda pode: com `BOOTSTRAP_ADMIN_PASSWORD` preenchida (16+ caracteres, política de senhas do §6.5), a conta nasce com troca de senha obrigatória no primeiro login.

Depois do primeiro login do ADMIN:

1. se usou `BOOTSTRAP_ADMIN_PASSWORD`, remova-a do `.env.production` e do secret manager;
2. pela tela **Administração**, cadastre serviços diagnósticos, códigos de motivo e colaboradores (tudo é auditado; só criar, promover, rebaixar, desativar ou redefinir um ADMIN pede a sua senha). Cadastre os **exames antes dos colaboradores**: um técnico novo recebe todos os exames ativos do setor, e um exame novo chega sozinho a quem já tinha todos os do setor (quem foi restrito a um subconjunto mantém o subconjunto);
3. confirme a trilha em `audit_events` (evento `ProductionBootstrap`).

O seed sintético (`npm run db:seed`) é proibido em produção e não deve ser usado para popular o ambiente.

## 4. Atualização (deploy contínuo)

```bash
# Backup ANTES do pull/build: --no-deps impede o Compose de executar o migrate
# (dependência do serviço backup) e aplicar migrations novas antes da cópia.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps backup --once
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

O PostgreSQL do Compose não publica porta no host, então `npm run db:backup` executado fora dos containers não o alcança; use o serviço `backup` (ou o backup gerenciado equivalente — ver [BACKUP_RESTORE.md](BACKUP_RESTORE.md)) e copie o arquivo para fora do host. Sem `--no-deps`, `run backup` inicia o `migrate` primeiro (verificado em 06/10/2026).

O `up -d` reexecuta `migrate` antes de recriar `app` e `worker`. As migrations são versionadas com checksum; uma migration alterada depois de aplicada aborta o deploy.

### 4.1 Atualização que contém as migrations 013, 014 ou 015 (cutover)

As migrations `013_audit_read_authority` e `014_outbox_read_authority` movem a auditoria e o outbox do snapshot para `audit_events` e `outbox_messages`. A `015_runtime_entity_rows` move as demais coleções para uma linha por entidade em `cvg_runtime_entities` (D-030); `cvg_runtime_state` fica só com versão, trava e cabeçalho. Cada uma cria uma constraint (`runtime_audit_is_transient`, `runtime_outbox_is_transient`, `runtime_entities_are_external`) que faz a versão antiga do app, que ainda grava no documento, falhar em todo comando clínico. O `up -d` do §4 **não serve** para esta atualização, porque roda o `migrate` com `app` e `worker` antigos no ar. Use esta ordem:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop proxy app worker backup
# obrigatório: o rollback deste cutover é só de dados. --no-deps evita rodar o migrate antes da cópia.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps backup --once
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

- Combine a janela de manutenção antes: o sistema fica indisponível entre o `stop` e o `up -d` (no ensaio com 100 mil eventos de auditoria a 013 levou cerca de 3 s; a 015 levou cerca de 3 s com 6 meses de dados, 27 mil exames e 47 MB de snapshot, incluindo a reconciliação; confirme com o volume real).
- As migrations abortam inteiras se encontrarem ID duplicado, entidade sem chave ou divergência entre snapshot e tabela (`ENTITY_CUTOVER_*` na 015); nesse caso nada é aplicado e o app antigo pode voltar com `up -d` da tag anterior.
- Depois de aplicadas, o código anterior **não** roda no schema novo. O rollback é o restore do backup tirado acima (§8).
- O `migrate` tem uma trava: uma migration que começa com `-- Coordinated cutover` (013, 014 e 015) **recusa rodar** enquanto houver outra sessão conectada ao banco, antes de executar qualquer SQL, com o erro `MIGRATION_CUTOVER_REQUIRES_STOPPED_RUNTIME:<versão>:<sessões>`. Se aparecer, algum `app`, `worker` ou console ainda está conectado: pare-o e rode de novo. `MIGRATION_CUTOVER_ACKNOWLEDGED=true` ignora a trava e só se usa quando se confirmou que as sessões restantes são inofensivas; nunca no Compose.
- Ensaie o cutover com um dump representativo antes de produção (PROD-503).

## 5. Verificação pós-deploy

```bash
curl -fsS https://$APP_DOMAIN/api/v1/readyz        # {"status":"ready","dataMode":"postgres","storageMode":"s3"}
curl -fsSI https://$APP_DOMAIN/login | grep -i -e strict-transport -e content-security-policy
docker compose -f docker-compose.prod.yml --env-file .env.production ps   # app healthy, worker up
docker compose -f docker-compose.prod.yml --env-file .env.production logs worker --tail 5   # eventos outbox.batch
```

A resposta HTML deve trazer `Content-Security-Policy` com `nonce-…`; o CI verifica que todo `<script>` carrega esse nonce.

### 5.1 Identidade do cliente e X-Forwarded-For forjado

**Aceite pendente no ambiente implantado.** A rota prioriza o primeiro endereço
de `X-Forwarded-For` e só usa `X-Real-IP` quando ele está ausente. Portanto,
injetar `X-Real-IP` não basta: a borda precisa descartar o endereço forjado
enviado pelo cliente. O Caddy ignora os valores recebidos de `X-Forwarded-*`
por padrão quando a origem não é um proxy confiável, conforme a
[documentação oficial](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).
O `deploy/Caddyfile` fornecido não configura `trusted_proxies`; conferir também
a configuração efetivamente carregada no ambiente e qualquer proxy anterior.

1. Confirmar `TRUST_PROXY=true`, segredo compartilhado igual no proxy e na
   aplicação e `/api/v1/readyz` respondendo 200 através da URL pública. Não
   enviar o segredo compartilhado nas requisições de teste: a borda deve
   injetá-lo.
2. Escolher um e-mail sintético único e inexistente no banco. Registrar o IP
   real da origem conforme a topologia implantada e os contadores antes do
   teste. Da mesma origem, executar as duas tentativas abaixo dentro de um
   minuto, substituindo o e-mail de exemplo pelo escolhido:

   ```bash
   curl --silent --show-error --max-time 20 --write-out '\nHTTP %{http_code}\n' \
     "https://$APP_DOMAIN/api/v1/session/login" \
     -H 'Content-Type: application/json' \
     -H 'X-Forwarded-For: 198.51.100.17' \
     --data '{"email":"proxy-check-unico@example.invalid","password":"proxy-check-invalid"}'
   curl --silent --show-error --max-time 20 --write-out '\nHTTP %{http_code}\n' \
     "https://$APP_DOMAIN/api/v1/session/login" \
     -H 'Content-Type: application/json' \
     -H 'X-Forwarded-For: 203.0.113.23' \
     --data '{"email":"proxy-check-unico@example.invalid","password":"proxy-check-invalid"}'
   ```

3. As duas respostas devem ser 401 por credenciais inválidas. Com acesso de
   leitura ao PostgreSQL, comparar `bucket_key`, `request_count` e
   `window_started_at` em `rate_limit_buckets` antes e depois. A chave do
   cliente é o SHA-256 do endereço usado pela rota, em hexadecimal, truncado
   para 32 caracteres. As duas tentativas devem incrementar o mesmo bucket
   `login-client:<chave-real>` e o par
   `login-account:<JSON.stringify([email, chave-real])>`, além do contador
   `login-failures:login-account:<JSON.stringify([email, chave-real])>`.
   Nenhum bucket correspondente ao hash dos dois IPs forjados deve ser criado
   ou incrementado. Apenas receber 401 não comprova esse aceite.
4. Anexar URL, data, versão/configuração do proxy, origem real, respostas e
   diferenças dos contadores ao registro de deploy, sem segredos. Se o IP
   forjado definir a chave, corrigir a borda e repetir antes de liberar o
   deploy. Um 503 exige revisar a configuração de identidade/dependências;
   um 429 exige repetir em janela com orçamento disponível.

Além desta verificação, o PROD-110 permanece pendente até o benchmark HTTP/SSE
em staging com p95, throughput e PostgreSQL real. O teste do proxy não
substitui esse benchmark.

## 6. Sessão, retenção, realtime e liveness

Variáveis desta seção vivem em `.env.production.example`; todas têm padrão e
nenhuma exige mudança no código para ser ajustada.

### 6.1 Timeout de inatividade de sessão

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` (30 min) | Sessão expira sem requisição autenticada dentro da janela. Valor inválido ou ≤ 0 cai no padrão. |
| `SESSION_ACTIVITY_TOUCH_INTERVAL_MS` | `60000` | Intervalo mínimo entre gravações de vivacidade da mesma sessão. |

A vivacidade fica na tabela `session_activity`, não no snapshot JSONB: uma
requisição autenticada custa uma leitura agregada, uma leitura de linha
indexada e, no máximo a cada intervalo, um UPSERT de linha única. Nenhuma
dessas três operações trava a linha global de estado. O UPSERT usa `GREATEST` para que observações atrasadas não recuem a atividade. Na criação de sessão, a atividade inicial participa da mesma transação do snapshot; falha na atividade provoca rollback do login.

Uma tela que só recebe SSE conta como atividade: o stream renova a vivacidade a
cada payload entregue, incluindo heartbeats, então uma fila ou um dashboard
com SSE ativo renova a janela mesmo sem eventos clínicos. Sem requisições
autenticadas nem SSE recebendo payloads, aplica-se o timeout de inatividade.
A expiração absoluta de 8 h continua valendo para a tela em monitoramento
(DECISION_LOG D-018).

### 6.2 Retenção técnica

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `RUNTIME_RETENTION_INTERVAL_MS` | `3600000` (1 h) | Cadência da poda dentro do worker do outbox. |
| `RATE_LIMIT_BUCKET_RETENTION_MS` | `7200000` (2 h; mínimo 1 h 1 min) | Por quanto tempo o worker mantém os contadores de limite de taxa depois que a janela acaba. Sem a poda, cada IP ou e-mail novo deixava uma linha para sempre. |
| `SESSION_RETENTION_MS` | `86400000` (24 h) | Mantém sessão expirada/revogada por esse tempo depois do fim. |
| `IDEMPOTENCY_RETENTION_MS` | `86400000` | Janela de replay de idempotência. |
| `OUTBOX_STATE_RETENTION_MS` | `86400000` | Idem para mensagens processadas no snapshot. |
| `STATE_OUTBOX_HOT_WINDOW` | `100` | Tamanho máximo da janela quente de mensagens processadas mantidas no snapshot. |

Cada execução que **remove algo** anexa um evento `RuntimeStateRetentionApplied` com contagens (uma execução vazia não grava nada), sem
identificador de sessão ou paciente. Para executar sob demanda:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm worker npm run runtime:retention
```

A auditoria não passa por esta poda: `audit_events` é append-only por trigger e por contrato, e desde a migration 013 é a única fonte de leitura. O snapshot guarda `auditEvents` vazio (constraint `runtime_audit_is_transient`).

### 6.3 Realtime

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `REALTIME_SHARED_READ_MIN_INTERVAL_MS` | `1000` | Uma leitura completa do estado por processo e por intervalo, compartilhada por todas as conexões. |
| `REALTIME_SHARED_NOTIFY_DEBOUNCE_MS` | `0` | Intervalo mínimo entre leituras provocadas por notificação de mutação. |

A autorização continua sendo revalidada antes de cada envio: pela versão do
estado lida na mesma consulta e, quando houve escrita no intervalo, por uma
leitura estreita de usuário e sessão. O orçamento é verificável:

```bash
npm run perf:realtime-budget   # gate: 100 conexões, ≤ 1 leitura/s por processo
```

O gate `npm run perf:snapshot:gate` compara bytes contra o baseline versionado; tempos de stringify, parse e clone são informativos. O gate temporal anterior variava com máquina/carga e não é usado para reprovar o CI. Ambos os harnesses medem custos locais e contagens, sem demonstrar p95 HTTP, latência ou locks no PostgreSQL.

### 6.4 Liveness do worker do outbox

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `OUTBOX_HEARTBEAT_FILE` | `/tmp/outbox-worker-heartbeat.json` | Arquivo de batimento. |
| `OUTBOX_HEARTBEAT_MAX_AGE_MS` | `30000` | Idade máxima aceita pelo probe. |
| `OUTBOX_HEARTBEAT_ERROR_TOLERANCE` | `3` | Ciclos com erro consecutivos até o container ficar `unhealthy`. |

O probe roda `node scripts/outbox-healthcheck.mjs`, sem transpilação, e confia
no veredito `health` que o próprio worker grava: um ciclo falho isolado é
`degraded` e não derruba o container. **Docker Compose não reinicia container
`unhealthy`**; o sinal serve para monitoramento externo ou orquestrador, e o
restart continua dependendo de `restart: unless-stopped` em caso de saída do
processo.

### 6.5 Limites de login e timeouts do banco

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `LOGIN_RATE_LIMIT` | `10` | Tentativas por minuto por conta (par e-mail + cliente), com backoff progressivo alimentado só por senha errada. |
| `LOGIN_CLIENT_RATE_LIMIT` | `60` | Tentativas por minuto por endereço de cliente, somando todas as contas. Estações atrás do mesmo NAT compartilham esse orçamento: dimensione acima dos logins de uma troca de turno. |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Espera máxima por uma conexão do pool. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | `statement_timeout` no servidor; o cliente desiste 5 s depois, mesmo com o servidor congelado. |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `60000` | Encerra uma transação parada que segure a trava global de escrita. |

Redefinição de senha e política de senhas (PROD-202 e PROD-203):

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `PASSWORD_RESET_TTL_MS` | `3600000` (60 min) | Validade do link de redefinição emitido pelo ADMIN; limitada a 5 min–24 h. Também vale para o link do bootstrap. |
| `PASSWORD_BREACH_CHECK` | `off` | `hibp` consulta o Have I Been Pwned (só os 5 primeiros caracteres do SHA-1 saem do servidor) ao definir ou trocar senha. O servidor do hospital pode ter saída restrita; por isso é opcional. |
| `PASSWORD_BREACH_CHECK_FAIL` | `open` | Com o serviço inacessível: `open` aceita a senha e registra o aviso `security.password_breach_check_unavailable`; `closed` recusa com 503. |
| `PASSWORD_BREACH_CHECK_TIMEOUT_MS` | `3000` | Tempo máximo da consulta (100–30000). |
| `LOGIN_ACCOUNT_SIGNAL_WINDOW_MS` | `900000` (15 min) | Janela do sinal agregado por conta (máx. 60 min). |
| `LOGIN_ACCOUNT_SIGNAL_THRESHOLD` | `20` | Senhas erradas somadas de todos os clientes, na janela, para uma conta; ao atingir, o Hub registra `security.login_distributed_attempts`, incrementa `cvg_login_distributed_attempt_signals_total` (alerta `CvgLoginDistributedAttempts`) e audita `LoginDistributedAttemptsDetected`. **Não bloqueia ninguém** (D-021). |

A lista local de senhas comuns funciona sem internet. Se o hospital liberar a saída para `api.pwnedpasswords.com:443`, ative `PASSWORD_BREACH_CHECK=hibp`.

Com o banco indisponível, toda rota responde `503 DEPENDENCY_UNAVAILABLE` com `retryable: true`, em vez de 500 ou de uma requisição pendurada; `/readyz` também responde 503.

### 6.6 Memória e volume de dados

Cada processo (`app` e `worker`) mantém o agregado de runtime inteiro em memória e o compartilha entre as leituras (D-030). A memória cresce, portanto, com o histórico clínico. O Compose limita o heap do Node abaixo do teto do container (`APP_HEAP_MB`, `WORKER_HEAP_MB`), para que a coleta de lixo trabalhe antes de o kernel matar o processo. Medição de 08/10/2026 com o lote real clonado ([relatório](../RELATORIO_ESCALA_2026-10-08.md)):

| Volume (≈150 exames/dia) | Heap do app | Pico do app | Worker | Lista / escrita (p50) |
| --- | --- | --- | --- | --- |
| 6 meses (27 mil exames) | 450 MB | 382 MB | 337 MB | 64 ms / 86 ms |
| 12 meses (55 mil) | 700 MB | 539 MB | 413 MB | 123 ms / 200 ms |
| 24 meses (110 mil) | 1.200 MB | 912 MB | 700 MB | 274 ms / 412 ms |

Os padrões (`APP_MEM_LIMIT=2g` com `APP_HEAP_MB=1280`, `WORKER_MEM_LIMIT=1g` com `WORKER_HEAP_MB=768`) cobrem cerca de dois anos nesse ritmo. Acima disso, ou com volume maior que o de D2, aumente os quatro valores na mesma proporção. A alternativa é reduzir o conjunto vivo: retenção clínica (D5/PROD-501) ou cutover relacional (PROD-111). Mantenha o heap em cerca de 65% do teto do container. Acompanhe o RSS dos dois processos; um `FATAL ERROR ... heap out of memory` no log indica heap pequeno para o volume atual.

### 6.7 Métricas e alertas (PROD-511)

`GET /api/v1/metrics` expõe métricas Prometheus agregadas, sem conteúdo clínico: requisições, latência, outbox (pendentes, idade da mais antiga, dead letters), tempo real, memória do processo contra o limite do heap e indicadores operacionais. Uma sessão ADMIN lê a rota; para o Prometheus, defina `METRICS_SCRAPE_TOKEN` (32+ caracteres, diferente de todos os outros segredos) e colete com `Authorization: Bearer <token>`. O token só abre essa rota, é comparado em tempo constante e tem limite próprio (`METRICS_SCRAPE_RATE_LIMIT`, padrão 60/min por cliente).

O app só responde atrás da borda em produção, porque o proxy injeta a identidade do cliente. Por isso a coleta é feita no endereço HTTPS público. Os arquivos ficam em `deploy/observability/`:

| Arquivo | Conteúdo |
| --- | --- |
| `prometheus.yml` | Coleta a cada 30 s. Troque `hub.example.org` pelo `APP_DOMAIN` e monte o token em `/etc/prometheus/secrets/metrics-scrape-token`. O alvo precisa ser o próprio `APP_DOMAIN`: o Caddy só atende esse host e, para outro nome, responde 200 vazio sem chegar ao app (o Prometheus mostra `up` = 1 com 0 amostras). |
| `alerts.yml` | 9 regras com severidade e runbook. Disponibilidade: coleta parada, readiness falhando, 5xx > 5%, latência média > 1 s. Entrega: notificação pendente > 5 min, dead letter. Capacidade: conexões de tempo real recusadas, heap > 85% do limite, reinício do processo. |
| `alerts.test.yml` | Testes `promtool` que provam que cada alerta dispara no seu sinal e não dispara fora dele. |
| `grafana-dashboard.json` | Painel com requisições, latência por rota, outbox, memória, tempo real, operação clínica e readiness. |

`npm run observability:check` valida a configuração, as regras e os testes com o `promtool` da imagem fixada por digest; a CI roda o mesmo comando. Em 08/10/2026, um Prometheus 3.15 real coletou a pilha de smoke em Compose pela borda TLS com o token: 105 amostras por coleta, heap em 3% de um limite de 1.304 MB e as 9 regras carregadas. O teste `alert-rules-contract.test.ts` falha se uma regra ou um painel citar uma métrica que o app não expõe.

Fica para o ambiente (D2, D11, PROD-513): donos e roteamento dos alertas; disparo de cada um em staging; métricas do PostgreSQL (`postgres_exporter`); validade do certificado e falha de backup (blackbox/cron). Os limiares são pontos de partida técnicos, e os clínicos (atraso de SLA, crítico) dependem de D3 e D7.

## 7. Papéis de banco separados (PROD-305)

Já faz parte do primeiro deploy e de toda atualização (§3): o serviço `migrate` roda `npm run db:roles` com três conexões, que o Compose monta sozinho:

| Variável | Papel | Quem recebe |
| --- | --- | --- |
| `DATABASE_ADMIN_URL` | `POSTGRES_USER` (administrativo) | só o `migrate` |
| `MIGRATION_DATABASE_URL` | `POSTGRES_MIGRATION_USER` (padrão `cvg_migrator`) | só o `migrate` |
| `DATABASE_URL` | `POSTGRES_RUNTIME_USER` (padrão `cvg_runtime`) | `app`, `worker`, `backup`, `bootstrap` |

O papel de runtime recebe DML sobre as tabelas existentes, `INSERT`/`SELECT` sobre `audit_events` e **não** recebe `CREATE` no schema; um teste de integração executa seis operações proibidas (`DELETE`, `UPDATE`, `TRUNCATE`, `ALTER`, `DROP`, `CREATE`) como esse papel e exige o código `42501`. Outro teste parte de um banco criado por um único superusuário, provisiona os papéis e confere que nada ficou com o dono antigo. Os dois papéis têm de ser usuários diferentes (`DATABASE_ROLES_MUST_BE_SEPARATE`).

Para um **banco gerenciado** em que um administrador já criou os papéis, deixe `DATABASE_ADMIN_URL` fora do `migrate`: o script então só aplica as migrations como migrador e os privilégios do runtime. Nesse caso, o administrador também deve conceder `GRANT pg_read_all_stats TO cvg_migrator`: sem ele, o PostgreSQL esconde do migrador o tipo das sessões de outros papéis, e a trava de cutover (§4.1) passa a esperar inclusive pelo autovacuum — continua segura, mas pode recusar sem necessidade. O `db:roles` concede esse papel sozinho quando recebe `DATABASE_ADMIN_URL` e registra `database.roles_stats_grant_skipped` se o administrador não puder concedê-lo.

## 8. Rollback

- **Aplicação:** refaça o build na tag anterior (`IMAGE_TAG`) e `up -d`. Se a versão nova aplicou migration, confirme antes que o código anterior aceita o schema novo (o `/readyz` exige a versão de migration esperada pelo código); caso contrário, o rollback é de dados.
- **Dados:** restaure conforme [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Nunca reexecute `bootstrap` para "consertar" um banco: ele recusa banco inicializado por desenho.

### 8.1 Plano por migration (PROD-503)

O `/readyz` exige que a última migration aplicada seja exatamente a que o código conhece. Por isso, uma versão anterior do app **não sobe** num schema mais novo, mesmo quando a migration só acrescenta estrutura. Depois de qualquer migration, há dois caminhos:
- **Corrigir para frente (padrão):** uma nova versão com a correção.
- **Voltar:** restaurar o backup tirado antes do `migrate` e subir a tag anterior. Isso perde o que foi escrito depois do backup.

| Migrations | Natureza | Antes de aplicar | Se der errado |
| --- | --- | --- | --- |
| 001–012 | Aditivas: tabelas, colunas, constraints, gatilhos; a 008 preenche `consumer_type` e a 009 valida dados legados | Backup (§4) | Abortam inteiras no erro (o runner aplica cada uma numa transação, com o ledger); corrigir o dado e rodar de novo |
| 013, 014 | Cutover coordenado: auditoria e outbox saem do snapshot | Parar `proxy`, `app` e `worker` e fazer backup (§4.1) | Abortam inteiras em divergência; depois de aplicadas, voltar exige o restore |
| 015 | Cutover coordenado: uma linha por entidade (D-030) | Idem | Aborta inteira em chave inválida, duplicada ou cópia divergente; depois de aplicada, voltar exige o restore |

**Ensaio de 08/10/2026 (dump representativo):**
1. Banco na 014 com 12 meses do lote real clonado: 55 mil exames, 95 MB de snapshot.
2. `pg_dump -Fc`, com dump de 3,2 MB, e `pg_restore` em outro banco: 3,8 s.
3. `npm run db:migrate` aplicou a 015 em 6,9 s, incluindo a reconciliação.
4. Resultado: 258.923 linhas de entidade e digest do estado igual ao original; o store abre e lê.

Com o volume real, repita o ensaio em homologação antes da janela.

## 9. Limites conhecidos

- Quem sabe a senha atual a troca em **Minha conta → Alterar senha** (`POST /session/password/change`, PROD-201): as outras sessões são encerradas. Para um colaborador que perdeu a senha, o gestor ou o ADMIN usa **Gerar nova senha** na linha do usuário: a senha temporária aparece uma vez, as sessões anteriores são encerradas e a troca é obrigatória no próximo login (redefinir um ADMIN exige reautenticação).
- RPO/RTO, roteamento de alertas e failover continuam abertos em [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
- **Backup:** o serviço `backup` do Compose grava um `pg_dump` diário (retenção de 14 dias) no volume `cvg-backups`, como o papel de runtime. É uma rede de segurança no mesmo servidor, não recuperação de desastre: copie o volume para fora da máquina e ensaie o restore ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)). Recuperação para um ponto no tempo (WAL) exige banco gerenciado ou arquivamento de WAL (D2 e D11).
- **Exames numéricos (hemograma em painel):** não existe tela nem API para criar o template laboratorial versionado; um serviço `NUMERIC_PANEL` só pode ser criado duplicando um que já tenha template. Em uma instalação nova, use serviços narrativos até a decisão D10 definir o catálogo e o carregamento dos templates.
- **Códigos de setor:** são texto livre, mas rótulos em português e filas reconhecem `LABORATORY`, `RADIOLOGY`, `ULTRASOUND`, `INPATIENT` e `IT`. Outros códigos funcionam e aparecem como foram digitados.
- **Logs e memória:** os containers rotacionam logs (`LOG_MAX_SIZE`, `LOG_MAX_FILE`) e têm teto de memória (`APP_MEM_LIMIT`, `WORKER_MEM_LIMIT`, `PROXY_MEM_LIMIT`).
- O stack de Compose é de host único; escalar `app` horizontalmente é suportado pelo runtime (rate limit e realtime em PostgreSQL), mas exige balanceador fora deste arquivo.
