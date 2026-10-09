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
| `postgres` | `postgres:16-alpine` | Com `wal_level=replica`, `archive_mode=on` e `archive_timeout` de `WAL_ARCHIVE_TIMEOUT_SECONDS`: cada segmento de WAL vai para o volume `cvg-wal-archive` ([`archive-wal.sh`](../../deploy/backup/archive-wal.sh)). Trocar por instância gerenciada ajustando `DATABASE_URL` abre mão deste arquivamento (D11 manda o banco no servidor do hospital). |
| `backup` | `postgres:16-alpine` + [`backup-loop.sh`](../../deploy/backup/backup-loop.sh) | Dump diário (papel de runtime), backup base diário (`pg_basebackup`, papel `cvg_backup`) e poda; volumes `cvg-backups` e `cvg-wal-archive`. |
| `offsite` | `rclone/rclone:1.71.2` + [`ship-offsite.sh`](../../deploy/backup/ship-offsite.sh) | Opt-in: copia o WAL, os dumps e os backups base para `OFFSITE_RCLONE_REMOTE` a cada `OFFSITE_SHIP_INTERVAL_SECONDS`, sem nunca apagar nem sobrescrever no destino, e recusa o ciclo (`offsite.refused`) se `/backups` não tiver backup válido recente. Sem destino, registra `offsite.disabled` e a aplicação sobe normalmente. `healthcheck` falha se o último envio com sucesso tiver mais de 3 intervalos. |

Armazenamento S3 e antivírus são **serviços obrigatórios fora do processo**: em produção o runtime recusa `STORAGE_MODE=local` e `STORAGE_SCAN_MODE=local`, e exige scanner em HTTPS com host na allowlist. Pela D11 eles rodam **no servidor do hospital**, pelo overlay [`docker-compose.onprem.yml`](../../docker-compose.onprem.yml) (§12): `storage` (MinIO), `storage-init`, `clamav` e `scanner` entram no mesmo projeto, sem porta publicada. Um S3 e um antivírus gerenciados continuam possíveis só com o arquivo base, apontando `STORAGE_ENDPOINT` e `MALWARE_SCANNER_ENDPOINT` para fora.

## 2. Pré-requisitos

1. Host com Docker Engine e Compose v2; DNS de `APP_DOMAIN` apontando para o host; portas 80/443 liberadas (ACME).
2. Armazenamento e antivírus: no modo on-prem (§12), `bash scripts/onprem-init.sh .data/onprem` gera a CA interna, o certificado do scanner e a chave de criptografia do MinIO, e o `storage-init` cria e endurece o bucket a cada `up`. Com serviços gerenciados: bucket criado (ou `npm run storage:init`) e endpoint do antivírus com API key, respondendo `{"status":"CLEAN"|"QUARANTINED"|"FAILED","detectedMime":...}`.
3. `.env.production` criado a partir de [`.env.production.example`](../../.env.production.example) com valores do secret manager. O arquivo é ignorado pelo git.

O `/readyz` falha (503) em produção, antes de tocar no banco, se `SESSION_SECRET` ou `TRUST_PROXY_SHARED_SECRET` tiverem menos de 32 caracteres ou se `TRUST_PROXY` não for `true`.

**Girar o `SESSION_SECRET`** encerra todas as sessões abertas e **invalida os links de redefinição de senha ainda não usados** (a impressão digital do token é calculada com o segredo, PROD-202). Faça a troca em janela de manutenção e, se alguém estava com um link pendente, emita outro depois (`POST /users/{id}/password-reset-link` ou `npm run db:reset-link`).

## 3. Primeiro deploy

Preencha o `.env.production` com **quatro segredos diferentes** de banco e aplicação: `POSTGRES_PASSWORD` (papel administrativo, usado só pelo `migrate`), `POSTGRES_MIGRATION_PASSWORD` (DDL), `POSTGRES_RUNTIME_PASSWORD` (app e worker) e `SESSION_SECRET`.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production --profile bootstrap run --rm bootstrap
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

O `migrate` (`scripts/db-roles.ts`) faz tudo o que o banco precisa, sem passo manual: cria os papéis `cvg_migrator` e `cvg_runtime` (e troca suas senhas se você as girar), entrega o banco, o schema e todos os objetos ao `cvg_migrator`, aplica as migrations e dá ao `cvg_runtime` só DML (sem DDL, e só `INSERT`/`SELECT` em `audit_events`). O `app`, o `worker` e o `backup` conectam como `cvg_runtime` e **não recebem** as credenciais de DDL nem a administrativa; só o `migrate` as tem. Funciona igual num banco novo e num banco que foi criado antes com um único superusuário.

**Primeiro acesso do ADMIN (PROD-202).** O caminho recomendado é deixar `BOOTSTRAP_ADMIN_PASSWORD` **vazio**. O `bootstrap` cria o ADMIN sem senha utilizável (hash aleatório) e imprime, uma única vez, o evento `{"event":"bootstrap.completed","adminId":"...","expiresAt":"..."}` e, numa linha separada, o link `https://<APP_DOMAIN>/reset-password?token=...`. O evento não leva o segredo, e o serviço `bootstrap` não tem driver de log (`logging: none`): o link só aparece no terminal de quem rodou o comando, nunca em `docker compose logs`, no disco do host ou num coletor de logs. Copie o link do terminal. Abra o link no navegador antes de `expiresAt` (`PASSWORD_RESET_TTL_MS`, padrão 60 min) e defina a senha: o link vale uma única vez, só o seu hash fica no banco e o primeiro login é feito com a senha nova. Se o link expirar, emita outro pelo comando de emergência (somente operador, exige a credencial do banco, é auditado como `PasswordResetLinkIssued` com `source: CLI`; qualquer usuário ativo, de qualquer perfil, substitui o link anterior e tem as sessões encerradas): `docker compose -f docker-compose.prod.yml --env-file .env.production --profile bootstrap run --rm --no-deps bootstrap node_modules/.bin/tsx scripts/password-reset-link.ts --email <email>` (pelo serviço `bootstrap`, sem driver de log, pelo mesmo motivo). Ele imprime `{"event":"password_reset_link.issued","userId":"...","expiresAt":"..."}`, o link numa linha separada, e sai com código 1 para usuário inexistente ou inativo. Quem prefere definir a senha no ambiente ainda pode: com `BOOTSTRAP_ADMIN_PASSWORD` preenchida (16+ caracteres, política de senhas do §6.5), a conta nasce com troca de senha obrigatória no primeiro login.

Depois do primeiro login do ADMIN:

1. se usou `BOOTSTRAP_ADMIN_PASSWORD`, remova-a do `.env.production` e do secret manager;
2. carregue o catálogo de exames pela planilha-modelo validada ([CATALOG_IMPORT.md](CATALOG_IMPORT.md): tela **Administração → Importar catálogo por planilha** ou `npm run catalog:import`, repetível em homologação e produção) e, pela tela **Administração**, cadastre códigos de motivo e colaboradores (a tela também cria ou ajusta exames avulsos) (tudo é auditado; só criar, promover, rebaixar, desativar ou redefinir um ADMIN pede a sua senha). Cadastre os **exames antes dos colaboradores**: um técnico novo recebe todos os exames ativos do setor, e um exame novo chega sozinho a quem já tinha todos os do setor (quem foi restrito a um subconjunto mantém o subconjunto);
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

### 6.8 Etiquetas e leitor de código de barras (PROD-405)

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ACCESSION_PREFIX` | `A` | Prefixo do accession gerado (`<PREFIXO><AAMMDD>-<NNNN><C>`), de 1 a 4 caracteres `[A-Z0-9]`. Valor inválido faz a criação de solicitações falhar (500) até ser corrigido. |
| `LABEL_WIDTH_MM` | `50` | Largura da etiqueta em milímetros (20 a 150). Define o `@page` da impressão. |
| `LABEL_HEIGHT_MM` | `30` | Altura da etiqueta em milímetros (20 a 150). |

A solicitação já nasce com a amostra e o accession; a etiqueta é aberta pelo link **Etiqueta** ao lado da amostra (detalhe da solicitação, painel do exame, área do paciente) e impressa pelo botão **Imprimir** do navegador. O código de barras é Code 128 e o dígito final do accession é um verificador Mod-10: um código lido ou digitado errado é recusado antes de qualquer mudança.

Qualquer leitor que funcione como teclado (digita o código e envia Enter) e qualquer impressora de etiquetas que imprima pelo navegador (driver do sistema operacional, tamanho de papel igual a `LABEL_*_MM`) funcionam; não há integração com modelo específico. No recebimento, o campo **Accession** já vem com o foco: ler a etiqueta confirma a amostra esperada, e deixar o campo vazio também.

O que o hospital ainda precisa informar: o **modelo da impressora** e o **tamanho real da etiqueta** (para ajustar `LABEL_WIDTH_MM`/`LABEL_HEIGHT_MM` e validar a margem de impressão) e o **modelo do leitor** (para confirmar que envia Enter ao final e lê Code 128). Até lá, os padrões de 50 × 30 mm valem como estimativa.

### 6.9 Canal WhatsApp do resultado crítico (PROD-402)

Pela decisão D3, o resultado crítico é avisado no Hub e também pelo WhatsApp Business, como canal redundante e sem SMS de reserva. A confirmação continua sendo feita no Hub.

**O que sai na mensagem:** um template aprovado pela Meta, da categoria UTILITY, em `pt_BR`.
- O corpo recebe só o protocolo da solicitação (`{{1}}`).
- O botão de URL recebe o caminho do Hub (`https://APP_DOMAIN/{{1}}`, por exemplo `results/<id>`).
- Nenhum dado clínico, nome de paciente ou valor de exame vai na mensagem.
- Sugestão de corpo para aprovar: "Hub CVG: há um resultado crítico aguardando a sua confirmação. Protocolo {{1}}. Abra o Hub para ver e confirmar."

**Quem recebe:** só quem cadastrou o próprio celular em **Minha conta**, com consentimento (§9).
- O número é conferido de novo no envio. Quem removeu o número ou já confirmou o alerta não recebe.
- Sem número cadastrado, a notificação registra `SKIPPED/NO_CONTACT` e o alerta fica só no Hub.

**Como ligar:**
1. Na Meta, criar o app, a conta WhatsApp Business e o número remetente. Aprovar o template.
2. Preencher `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (token permanente de usuário do sistema) e `WHATSAPP_TEMPLATE_NAME` no `.env.production`.
   - O app e o worker leem o mesmo bloco do Compose.
   - Com `WHATSAPP_ENABLED=true` e a configuração incompleta, o worker não sobe (`WHATSAPP_CONFIG_INVALID:<variável>`).
3. Liberar a saída HTTPS do servidor para `graph.facebook.com:443`.
4. Para os relatórios de entrega, gerar `WHATSAPP_VERIFY_TOKEN` (aleatório) e copiar o app secret para `WHATSAPP_APP_SECRET`. Na Meta, configurar o webhook `https://APP_DOMAIN/api/v1/webhooks/whatsapp` com o mesmo verify token e assinar o campo `messages`.
   - Sem os dois segredos, a rota responde 404.
   - O `POST` só é aceito com `X-Hub-Signature-256` válido sobre o corpo exato.
5. Ligar `WHATSAPP_ENABLED=true` junto com a política crítica (`CRITICAL_POLICY_*`) e fazer um teste com um crítico de homologação.

**Servidor só na rede interna (D11):** o envio funciona, desde que haja saída para a Meta. Os relatórios de entrega e leitura só chegam se o webhook for alcançável pela internet. Sem eles, o alerta fica em `SENT`. O escalonamento depende da confirmação no Hub, não do status do WhatsApp.

**Estados no campo `whatsapp` da notificação:**
- `QUEUED` → `SENT` → `DELIVERED` → `READ`;
- `FAILED`, com o código da Meta;
- `SKIPPED`: `NO_CONTACT`, `SETTLED` ou `CHANNEL_DISABLED`.

Cada mudança gera um evento de auditoria (`CriticalAlertWhatsApp*`) sem o número. Desligar o canal faz os alertas na fila serem encerrados como `CHANNEL_DISABLED`. Falhas de credencial ou de template vão para o dead letter (runbook "WhatsApp do crítico").

**Escalonamento ao plantão:** quem roda é o worker, a cada ciclo, só com a política crítica ativa.
- Se ninguém confirmou o crítico, a cada limiar de `CRITICAL_POLICY_ESCALATION_AFTER_MS` (padrão 15, 30 e 60 min após a liberação) o Hub avisa o próximo degrau de `CRITICAL_POLICY_RECIPIENT_RULES`. Cada degrau é a primeira regra que alcança alguém ainda não avisado.
- A D3 pede o plantão primeiro. Uma escada que segue isso: `REQUESTER,ON_CALL,RESPONSIBLE,DEPARTMENT_MANAGER`.
- Plantão: todos os profissionais ativos do setor solicitante marcados com **Colocar no plantão**.
- Gestor: quem gerencia o setor solicitante, mesmo lotado em outro setor, e também o setor do exame (sem ele, o gestor não abre o resultado).
- Só entra quem consegue abrir o resultado, depois da concessão de paciente abaixo. ADMIN e VIEWER ficam de fora, um executor só entra se tiver o exame no seu escopo e um gestor só se gerenciar o setor do exame. Quem não consegue abrir é pulado, e o degrau vai para a próxima regra.
- Cada pessoa avisada recebe a própria notificação crítica, no Hub e pelo WhatsApp se tiver número cadastrado.
- Veterinários e equipe de internação passam a ter o paciente no escopo para abrir o resultado. A concessão fica auditada (`CriticalEscalationPatientAccessGranted`).
- A confirmação de qualquer pessoa que consiga abrir o resultado interrompe a escalada. Quem perdeu o acesso (por exemplo, mudou de perfil depois de avisado) recebe `SCOPE_DENIED` ao confirmar, e a escalada continua.
- Worker parado além de um limiar: ao voltar, ele sobe um nível por ciclo até alcançar o relógio. Nenhum nível é pulado nem repetido.
- Esgotada a escada, o nível fica registrado com a regra `NONE` e o crítico continua pendente no painel de gestão, contado uma vez por resultado.
- Toda subida gera `CriticalResultEscalated` na auditoria e uma linha `critical.escalation` no log do worker.

### 6.10 Arquivamento clínico (PROD-501)

Decisão D5: solicitações concluídas há mais de 24 meses saem do agregado ativo e passam a `cvg_clinical_archive` (consulta somente leitura por paciente e por solicitação); o expurgo no prazo legal existe e fica desligado até o jurídico definir o prazo. O job roda no worker, depois da retenção técnica. Detalhes, ensaio e expurgo em [CLINICAL_ARCHIVE](CLINICAL_ARCHIVE.md).

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ARCHIVE_ACTIVE_MONTHS` | `24` | Meses de permanência no agregado ativo. `0` desliga o arquivamento. |
| `ARCHIVE_INTERVAL_MS` | `86400000` (24 h; mínimo 1 h) | Cadência do job no worker. |
| `ARCHIVE_PURGE_AFTER_MONTHS` | vazio | Prazo legal em meses a partir do arquivamento. Vazio ou `0`: nenhum expurgo; ao definir, o worker também remove os anexos do S3. |

Sob demanda: `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm worker npm run runtime:archive -- --dry-run` (ensaio; `--apply` aplica, `--purge` exige o prazo legal definido). Cada lote grava um evento `ClinicalRecordsArchived` só com contagens.

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
| 016 | Aditiva (rolling): a rota do outbox passa a aceitar `notification.whatsapp` (PROD-402) | Backup (§4) | Só troca uma constraint; as linhas existentes continuam válidas. Para voltar, restaurar o backup ou deixar o canal desligado |

**Ensaio de 08/10/2026 (dump representativo):**
1. Banco na 014 com 12 meses do lote real clonado: 55 mil exames, 95 MB de snapshot.
2. `pg_dump -Fc`, com dump de 3,2 MB, e `pg_restore` em outro banco: 3,8 s.
3. `npm run db:migrate` aplicou a 015 em 6,9 s, incluindo a reconciliação.
4. Resultado: 258.923 linhas de entidade e digest do estado igual ao original; o store abre e lê.

Com o volume real, repita o ensaio em homologação antes da janela.

## 9. Limites conhecidos

- Quem sabe a senha atual a troca em **Minha conta → Alterar senha** (`POST /session/password/change`, PROD-201): as outras sessões são encerradas. Para um colaborador que perdeu a senha, o gestor ou o ADMIN usa **Gerar nova senha** na linha do usuário: a senha temporária aparece uma vez, as sessões anteriores são encerradas e a troca é obrigatória no próximo login (redefinir um ADMIN exige reautenticação).
- **Alertas de resultado crítico no WhatsApp (PROD-402):** cada profissional cadastra o próprio celular em **Minha conta → Resultado crítico no WhatsApp**, com consentimento. Ninguém cadastra por outra pessoa. O gestor ou o ADMIN marca quem está de plantão com **Colocar no plantão**, na linha do usuário, que também mostra se a pessoa já tem número. Desativar um acesso tira a pessoa do plantão.
- RPO/RTO, roteamento de alertas e failover continuam abertos em [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
- **Backup:** o Compose mantém um dump diário, um backup base diário e o arquivamento contínuo de WAL (retenção de 14 dias), e o serviço `offsite` leva tudo, inclusive o bucket de anexos no modo on-prem, para fora do servidor ([BACKUP_RESTORE.md](BACKUP_RESTORE.md), §10 e §12). O PITR e o restore do bucket foram ensaiados só em laboratório (`npm run db:backup:drill`, `npm run storage:backup:drill`); o restore cronometrado no servidor e no destino reais segue pendente (PROD-514).
- **Exames numéricos (hemograma em painel):** a tela de cadastro avulso só cria `NUMERIC_PANEL` duplicando um serviço que já tenha template. O painel versionado (analitos, unidades e faixas) entra pela importação de planilha ([CATALOG_IMPORT.md](CATALOG_IMPORT.md), D-035); faixas por espécie ainda não existem no modelo e seguem como observação.
- **Códigos de setor:** são texto livre, mas rótulos em português e filas reconhecem `LABORATORY`, `RADIOLOGY`, `ULTRASOUND`, `INPATIENT` e `IT`. Outros códigos funcionam e aparecem como foram digitados.
- **Logs e memória:** os containers rotacionam logs (`LOG_MAX_SIZE`, `LOG_MAX_FILE`) e têm teto de memória (`APP_MEM_LIMIT`, `WORKER_MEM_LIMIT`, `PROXY_MEM_LIMIT`).
- O stack de Compose é de host único; escalar `app` horizontalmente é suportado pelo runtime (rate limit e realtime em PostgreSQL), mas exige balanceador fora deste arquivo.

## 10. Backup contínuo e cópia externa (PROD-304)

Variáveis novas (todas em `.env.production.example`):

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `POSTGRES_BACKUP_PASSWORD` | vazio | Senha do papel `cvg_backup` (`REPLICATION` + `pg_read_all_data`), criado pelo `migrate` e usado só pelo `pg_basebackup` do serviço `backup`. Use um valor distinto dos outros segredos. Vazio = sem backup base e sem PITR (o dump diário continua). Entra no `migrate` e no `backup`, nunca no `app` nem no `worker`. |
| `WAL_ARCHIVE_TIMEOUT_SECONDS` | `300` | `archive_timeout` do PostgreSQL: um segmento é fechado e arquivado pelo menos a cada 5 min. Com o envio de 300 s o RPO nominal é 10 min (orçamento D2: 15 min). |
| `OFFSITE_RCLONE_REMOTE` | vazio | Destino do rclone, `<remoto>:<caminho>` (`s3:cvg-offsite/hospital-a`, `sftp:/backups`). Vazio desliga a cópia externa. |
| `OFFSITE_RCLONE_CONFIG` | `./deploy/backup/rclone.conf.example` no Compose; `./deploy/backup/rclone.conf` no `.env.production.example` | Arquivo de configuração do rclone, montado somente leitura em `/config/rclone/rclone.conf`. O arquivo real fica fora do git (`.gitignore` e `scripts/secret-scan.sh` exigem isso); crie-o a partir de [`rclone.conf.example`](../../deploy/backup/rclone.conf.example) **antes** do `up`, senão o Docker cria um diretório no lugar. |
| `OFFSITE_SHIP_INTERVAL_SECONDS` | `300` | Intervalo do envio e base do `healthcheck` (3 × intervalo). |
| `OFFSITE_MAX_BACKUP_AGE_SECONDS` | vazio (2 × `BACKUP_INTERVAL_SECONDS` = `172800`) | Idade máxima do backup mais novo em `/backups` (dump ou backup base não vazio) para o ciclo de cópia externa ser aceito; acima disso o ciclo é recusado. |

Atualização de uma instalação existente: definir `POSTGRES_BACKUP_PASSWORD`, rodar `up -d` (recria o `postgres` com os novos parâmetros, com uma reinicialização curta do banco, e o `migrate` cria o papel) e esperar o primeiro backup base (`docker compose ... logs backup`, evento `basebackup.completed`) antes de contar com o PITR. O `pg_hba` passa a vir de [`deploy/backup/pg_hba.conf`](../../deploy/backup/pg_hba.conf) (mesmas regras da imagem mais a linha de replicação do `cvg_backup`).

O que o hospital ainda precisa fornecer (D11): o **servidor** (disco para banco + WAL + backups: reserve pelo menos 100 GB além do banco para 14 dias de WAL a `archive_timeout` 300 s, dumps e backups base; CPU/RAM conforme §6.6), o **destino externo** fora do prédio (bucket S3-compatível, outro site por SFTP ou equivalente, com política de ciclo de vida para `wal/`), as **credenciais** desse destino e quem as guarda, e os **operadores** que acompanham o `healthcheck` do `offsite` e fazem o ensaio mensal. Sem eles o mecanismo está pronto e ensaiado em laboratório, mas o RPO de 15 min **fora do prédio** não está garantido.

## 11. Pipeline de release (PROD-303)

O servidor do hospital deixa de compilar imagens. O workflow [`release.yml`](../../.github/workflows/release.yml) roda depois de cada CI verde num push para `main`:

1. **publish:** compila uma vez a imagem da aplicação (`<prefixo>:sha-<12 hex do commit>`) e a operacional (`<prefixo>-ops:sha-…`), ambas com o rótulo `org.opencontainers.image.revision=<commit>`. Depois as audita com Trivy, reprovando CRITICAL/HIGH com correção disponível (mesmo critério do CI). Por fim gera o SBOM CycloneDX das duas, publica e guarda os digests no artefato `release-sha-…` e no resumo do job.
2. **promote-staging:** move a tag `staging` das duas imagens para essa release, sem aprovação (homologação automática).
3. **promote-production:** move a tag `production`. O job usa o ambiente `production` do GitHub e espera a aprovação de quem estiver em *required reviewers*. Antes de mover a tag ele confere, pela API, que o ambiente tem revisores obrigatórios; se não tiver, falha.

Tag por commit é imutável por convenção: o `deploy.sh` recusa `latest`, `staging` e `production` e só aceita `sha-<hex>`.

**No servidor (modelo pull, D-045).** Um timer roda [`deploy/release/pull-release.sh`](../../deploy/release/pull-release.sh), que segue um canal: baixa `<prefixo>:<canal>` e `<prefixo>-ops:<canal>`, confere que as duas vêm do mesmo commit e, se esse commit não é o que está no ar, chama [`deploy/release/deploy.sh`](../../deploy/release/deploy.sh). O servidor só faz chamadas de saída. Não há SSH de fora para dentro nem runner do GitHub dentro da rede do hospital (PROD-309), e o repositório é público: um runner próprio executaria código de PRs de terceiros.

O `deploy.sh` faz, nesta ordem:

1. baixa as duas imagens da release;
2. recusa a imagem cujo rótulo não é o commit da tag (`release.revision_mismatch`);
3. faz o backup (`run --rm --no-deps backup --once`; sem backup, sem deploy);
4. roda `up -d --no-build`, em que o `migrate` executa antes de `app` e `worker` serem recriados;
5. espera o `app` ficar `healthy` (`RELEASE_HEALTH_TIMEOUT_SECONDS`, padrão 300) e o `worker` rodando;
6. registra a release em `<state-dir>/<projeto>.current` e `.history`.

Cada passo emite um evento JSON (`release.started`, `release.deployed` com a release anterior, ou o erro do passo). Com `--maintenance`, ele para `proxy`, `app`, `worker` e `backup` antes do backup e roda o `migrate` sozinho. É o caminho das migrations de cutover coordenado do §4.1. Sem a opção, a trava do `migrate` recusa essas migrations e o app antigo continua no ar.

Nada é desfeito automaticamente. Uma release que falhou no servidor fica registrada em `<projeto>.failed` e o timer não a tenta de novo. O operador corrige e roda `deploy.sh` à mão, ou apaga o arquivo. Para voltar, rode `deploy.sh --tag <release anterior>` (o `.history` guarda a lista), o que só vale se a release não aplicou migration. Com migration aplicada, o caminho é o restore do backup tirado pelo próprio deploy (§8).

Exemplo de unidade systemd para homologação. Para produção, troque o canal, o projeto, o arquivo de ambiente e o `--compose-file` conforme a separação do PROD-301.

```ini
# /etc/systemd/system/cvg-release-hml.service
[Service]
Type=oneshot
WorkingDirectory=/opt/cvg-hub
ExecStart=/opt/cvg-hub/deploy/release/pull-release.sh --channel staging --project cvg-hml --env-file /etc/cvg-hub/hml.env --prefix ghcr.io/<dono>/cvg-hub --compose-file docker-compose.prod.yml

# /etc/systemd/system/cvg-release-hml.timer
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target
```

O diretório `/opt/cvg-hub` é um checkout do repositório. Os arquivos de Compose e os scripts de `deploy/` vêm dele, então o operador o atualiza para o commit da release (`git fetch && git checkout <commit>`) antes da primeira subida e sempre que o Compose mudar.

**Para ligar (decisões do dono do produto e do hospital):**

| Onde | O quê |
| --- | --- |
| Variável do repositório `RELEASE_PUBLISH_ENABLED` | `true` liga o workflow. Desligado, nada é publicado. |
| Variável `RELEASE_IMAGE_PREFIX` (opcional) | Outro registry, por exemplo um do próprio hospital, com os segredos `RELEASE_REGISTRY_USERNAME` e `RELEASE_REGISTRY_PASSWORD`. O padrão é `ghcr.io/<dono>/cvg-hub` com o token do próprio workflow. |
| Ambiente `production` (Settings → Environments) | *Required reviewers* com quem aprova a ida para produção. Sem isso o job falha antes de mover a tag. |
| Servidor | `docker login` no registry com token **somente leitura**, caso a imagem seja privada, e os timers acima. |

O primeiro deploy de um ambiente continua sendo o §3. A única diferença é que, em vez de `build`, o operador exporta `IMAGE_PREFIX` e `IMAGE_TAG=sha-…` e roda `pull`.
## 12. Armazenamento e antivírus no servidor do hospital (modo on-prem, PROD-307/308/514)

D11 põe o servidor dentro do hospital. O overlay [`docker-compose.onprem.yml`](../../docker-compose.onprem.yml) acrescenta ao stack de produção o armazenamento de objetos e o antivírus, sem nenhuma porta publicada, e a decisão está em [D-050](../DECISION_LOG.md):

| Serviço | Imagem / origem | Papel |
| --- | --- | --- |
| `storage` | MinIO compilado da fonte pinada ([`deploy/minio/Dockerfile`](../../deploy/minio/Dockerfile), revisão `7aac2a2`) | Bucket de anexos. Criptografia em repouso de todo objeto com a chave do segredo `minio-kms-key` (`MINIO_KMS_SECRET_KEY_FILE`, `MINIO_KMS_AUTO_ENCRYPTION=on`); console desligado; volume `cvg-storage`. |
| `storage-init` | imagem `ops`, [`scripts/init-storage.ts`](../../scripts/init-storage.ts) com `STORAGE_HARDEN=true` | A cada `up`, cria o bucket se faltar e **aplica e verifica** o endurecimento: versionamento, criptografia padrão (SSE), policy sem acesso anônimo (grava um objeto de prova, confirma `x-amz-server-side-encryption` e que um `GET` sem credencial responde `403`, apaga a prova) e o ciclo de vida. Se algo desviar, sai com código 1 e `app` e `worker` não sobem. |
| `clamav` | `clamav/clamav` pelo digest | Antivírus real; carrega a base de assinaturas embutida e a atualiza com `freshclam` quando há saída para `database.clamav.net`; volume `cvg-clamav`. |
| `scanner` | `node:22-bookworm-slim` + [`deploy/local/scanner.mjs`](../../deploy/local/scanner.mjs) | Adaptador HTTPS entre o contrato de varredura do app e o `clamd` (mesmo arquivo da instalação local; `CLAMD_HOST`/`CLAMD_PORT`, certificado em `/certs`). Só responde com a API key e sobre HTTPS; o app o aceita porque `scanner` está na allowlist e a CA interna vai em `NODE_EXTRA_CA_CERTS`. |

**Ciclo de vida "conforme D5" (D-050).** Os 24 meses de D5 são do arquivamento clínico no banco ([CLINICAL_ARCHIVE.md](CLINICAL_ARCHIVE.md)): o anexo continua no bucket, dentro do prazo legal, até o expurgo do PROD-501, que é quem apaga o objeto. Por isso o bucket **não tem** expiração nem transição por idade de objeto corrente: a única regra (`cvg-noncurrent-versions`) apaga versões não correntes, que nascem de uma exclusão ou substituição, depois de `STORAGE_NONCURRENT_VERSION_DAYS` (padrão 30), e os marcadores de exclusão órfãos. Esses dias são a janela para desfazer uma exclusão errada ou um ataque que tenha apagado objetos. A verificação recusa qualquer regra com `Expiration.Days`/`Date` ou `Transition`, para que ninguém a acrescente por engano no console de um S3 gerenciado.

**Primeira subida.**

```bash
bash scripts/onprem-init.sh .data/onprem        # CA, certificado do scanner (SAN scanner), chave KMS; nunca commitado
# .env.production: STORAGE_ENDPOINT=http://storage:9000, STORAGE_FORCE_PATH_STYLE=true, STORAGE_BUCKET=cvg-attachments,
#   MALWARE_SCANNER_ENDPOINT=https://scanner:9443/scan, MALWARE_SCANNER_ALLOWED_HOSTS=scanner, MALWARE_SCANNER_API_KEY (32+),
#   STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY (viram o usuário raiz do MinIO), ONPREM_DIR=./.data/onprem
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml --env-file .env.production build storage   # uma vez: imagem do MinIO
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml --env-file .env.production logs storage-init   # {"event":"storage.hardened",...,"problems":[]}
```

Todos os comandos do §3 e do §4 valem com os dois `-f`; o [`deploy.sh`](../../deploy/release/deploy.sh) do §11 recebe o overlay por `--compose-file` repetido (a imagem do `storage` não vem do registry, por isso o `build storage` único acima). Verificação sob demanda, sem alterar nada: `docker compose ... run --rm --no-deps storage-init node_modules/.bin/tsx scripts/init-storage.ts --verify` (ou `npm run storage:verify` com as variáveis exportadas) imprime o relatório e sai com 1 se o bucket desviou. Ensaios reproduzíveis: `npm run scanner:drill` (EICAR em quarentena com ClamAV real) e `npm run storage:backup:drill` (perda do volume e restore a partir da cópia externa, [BACKUP_RESTORE.md §4.5](BACKUP_RESTORE.md#45-restaurar-o-bucket-de-anexos-a-partir-da-cópia-externa)).

**Segredos que o hospital guarda.** `.data/onprem/minio-kms.key` (sem ela, nenhum anexo é legível: copie para o cofre junto com as senhas do banco; trocar a chave exige migração com ensaio de restore) e `.data/onprem/certs/ca.key` (assina o certificado do scanner; `bash scripts/onprem-init.sh .data/onprem --renew-scanner` renova o certificado, válido por 825 dias, com `restart` do `scanner`). O `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` é o usuário raiz do MinIO, usado pelo app, pelo worker (expurgo) e pela cópia externa; sem console nem porta publicada, só o Compose o alcança.

**Quarentena.** O que acontece com um arquivo que o ClamAV marca, quem é o dono e os passos estão em [INCIDENT_RUNBOOKS.md](INCIDENT_RUNBOOKS.md#storage-upload-ou-scanner-av-indisponível); o sinal é o alerta `CvgAttachmentQuarantined` ([OBSERVABILITY.md](OBSERVABILITY.md)). Sem saída para a internet, as assinaturas do ClamAV ficam na versão embutida na imagem: libere `database.clamav.net` no firewall (PROD-309) ou atualize a imagem a cada release.

**Cópia externa do bucket (PROD-514).** O overlay define o remoto `minio` do rclone a partir das variáveis `STORAGE_*` e passa `OFFSITE_BUCKET_SOURCE=minio:<bucket>` ao serviço `offsite`: a cada ciclo os objetos vão para `<OFFSITE_RCLONE_REMOTE>/objects` com `rclone copy --ignore-existing` (nunca apaga nem sobrescreve no destino, D-041) e o ciclo é recusado (`offsite.refused`, `bucket source unreachable`) se o bucket não puder ser listado. O `offsite-status.json` ganha `objects` (contagem no bucket). Retenção no destino: as versões não correntes não saem do servidor (o rclone copia só a versão corrente), então o destino guarda uma cópia de cada objeto gravado desde a ativação, inclusive os que o expurgo apagou; expirar `objects/` no destino é uma regra de ciclo de vida do próprio destino, com prazo igual ao legal, decidida com o jurídico. O restore está em [BACKUP_RESTORE.md §4.5](BACKUP_RESTORE.md#45-restaurar-o-bucket-de-anexos-a-partir-da-cópia-externa).

**Variáveis** (todas em `.env.production.example`): `ONPREM_DIR` (`./.data/onprem`), `MINIO_IMAGE_TAG` (`7aac2a2`), `STORAGE_NONCURRENT_VERSION_DAYS` (`30`), `STORAGE_MEM_LIMIT` (`1g`), `CLAMAV_MEM_LIMIT` (`2g`), `OFFSITE_BUCKET_SOURCE` (o overlay fixa `minio:<STORAGE_BUCKET>`).

O que o hospital ainda precisa fornecer: o servidor (disco para o bucket além do banco e dos backups), o cofre para a chave KMS e a CA, o nome do responsável pela quarentena (PROD-516) e o destino externo com a regra de retenção de `objects/`.
