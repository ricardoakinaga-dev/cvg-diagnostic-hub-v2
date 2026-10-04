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

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production --profile bootstrap run --rm bootstrap
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Depois do primeiro login do ADMIN:

1. remova `BOOTSTRAP_ADMIN_PASSWORD` do `.env.production` e do secret manager;
2. pela tela **Administração**, cadastre serviços diagnósticos, códigos de motivo e colaboradores (cada ação exige reautenticação recente e é auditada);
3. confirme a trilha em `audit_events` (evento `ProductionBootstrap`).

O seed sintético (`npm run db:seed`) é proibido em produção e não deve ser usado para popular o ambiente.

## 4. Atualização (deploy contínuo)

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
npm run db:backup   # ou o backup gerenciado equivalente — ver BACKUP_RESTORE.md
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

O `up -d` reexecuta `migrate` antes de recriar `app` e `worker`. As migrations são versionadas com checksum; uma migration alterada depois de aplicada aborta o deploy.

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
| `SESSION_RETENTION_MS` | `86400000` (24 h) | Mantém sessão expirada/revogada por esse tempo depois do fim. |
| `IDEMPOTENCY_RETENTION_MS` | `86400000` | Janela de replay de idempotência. |
| `OUTBOX_STATE_RETENTION_MS` | `86400000` | Idem para mensagens processadas no snapshot. |
| `STATE_OUTBOX_HOT_WINDOW` | `100` | Tamanho máximo da janela quente de mensagens processadas mantidas no snapshot. |

Cada execução anexa um evento `RuntimeStateRetentionApplied` com contagens, sem
identificador de sessão ou paciente. Para executar sob demanda:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm worker npm run runtime:retention
```

A poda da auditoria no snapshot está **fora** de escopo: `audit_events` é
append-only por trigger e por contrato, e só sai do snapshot com o cutover
relacional (PROD-101/PROD-111).

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

## 7. Papéis de banco separados (PROD-305)

O deploy inicial usa dois papéis distintos:

```bash
# 1. papel de migração (DDL): roda as migrations e concede privilégios
MIGRATION_DATABASE_URL=postgresql://cvg_migrator:...@postgres:5432/cvg_production \
DATABASE_URL=postgresql://cvg_runtime:...@postgres:5432/cvg_production \
  npm run db:roles

# 2. application e worker usam apenas DATABASE_URL
```

`db:roles` é idempotente, recria a divisão a cada deploy e é a única etapa que
precisa de conexão administrativa. O papel de runtime recebe DML sobre as
tabelas existentes, `INSERT`/`SELECT` sobre `audit_events` e **não** recebe
`CREATE` no schema; um teste de integração executa seis operações proibidas
(`DELETE`, `UPDATE`, `TRUNCATE`, `ALTER`, `DROP`, `CREATE`) como esse papel e
exige o código `42501`. Se os dois papéis forem o mesmo usuário, o script
recusa com `DATABASE_ROLES_MUST_BE_SEPARATE`.

## 8. Rollback

- **Aplicação:** refaça o build na tag anterior (`IMAGE_TAG`) e `up -d`. Se a versão nova aplicou migration, confirme antes que o código anterior aceita o schema novo (o `/readyz` exige a versão de migration esperada pelo código); caso contrário, o rollback é de dados.
- **Dados:** restaure conforme [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Nunca reexecute `bootstrap` para "consertar" um banco: ele recusa banco inicializado por desenho.

## 9. Limites conhecidos

- Não há troca/redefinição de senha self-service. Para um colaborador que perdeu a senha, o ADMIN desativa a conta e cria outra.
- RPO/RTO, roteamento de alertas e failover continuam abertos em [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
- O stack de Compose é de host único; escalar `app` horizontalmente é suportado pelo runtime (rate limit e realtime em PostgreSQL), mas exige balanceador fora deste arquivo.
