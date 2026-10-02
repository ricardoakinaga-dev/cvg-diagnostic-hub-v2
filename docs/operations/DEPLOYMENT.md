# Deploy de produção

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

## 6. Rollback

- **Aplicação:** refaça o build na tag anterior (`IMAGE_TAG`) e `up -d`. Se a versão nova aplicou migration, confirme antes que o código anterior aceita o schema novo (o `/readyz` exige a versão de migration esperada pelo código); caso contrário, o rollback é de dados.
- **Dados:** restaure conforme [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Nunca reexecute `bootstrap` para "consertar" um banco: ele recusa banco inicializado por desenho.

## 7. Limites conhecidos

- Não há troca/redefinição de senha self-service. Para um colaborador que perdeu a senha, o ADMIN desativa a conta e cria outra.
- RPO/RTO, roteamento de alertas e failover continuam abertos em [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
- O stack de Compose é de host único; escalar `app` horizontalmente é suportado pelo runtime (rate limit e realtime em PostgreSQL), mas exige balanceador fora deste arquivo.
