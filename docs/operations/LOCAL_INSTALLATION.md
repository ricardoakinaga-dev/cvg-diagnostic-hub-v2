# Instalação local — Diagnostic Hub

Instância instalada em 03/10/2026 neste workspace, com o projeto Compose
`cvg-diagnostic-local`. Acesso: **https://localhost:18443**.

## Acesso

- Conta inicial: `admin@diagnostic.local`, papel `ADMIN`.
- Senha gerada: arquivo privado `.data/local-deploy/access.json`,
  com permissão `0600`. A senha foi retirada do ambiente de bootstrap.
- HTTPS: certificado local assinado pela CA em `.data/local-deploy/certs/ca.crt`.
  Para evitar o aviso de certificado, importar essa CA nas autoridades
  confiáveis do navegador usado para acessar o Hub. Nenhuma CA foi instalada
  no trust store global da máquina. Os certificados expiram em 03/10/2027.
- Banco inicializado com uma conta administrativa, sem pacientes, catálogo
  sintético ou credenciais das outras aplicações. A tela Administração
  permite provisionar serviços e usuários.

## Serviços e isolamento

| Serviço | Função | Porta publicada no host |
| --- | --- | --- |
| `proxy` | Caddy, TLS e identidade confiável do cliente | `127.0.0.1:18443` |
| `app` | Next.js, Node 22, `NODE_ENV=production` | nenhuma |
| `worker` | Outbox e retenção técnica | nenhuma |
| `postgres` | PostgreSQL 16, banco exclusivo e papéis separados | nenhuma |
| `storage` | MinIO, bucket `diagnostic-attachments` | nenhuma |
| `scanner` | Adaptador HTTPS para o contrato de varredura do app | nenhuma |
| `clamav` | Antivírus real com atualização de assinaturas | nenhuma |

Configuração: [docker-compose.local.yml](../../docker-compose.local.yml),
[Caddyfile local](../../deploy/local/Caddyfile) e
[adaptador do scanner](../../deploy/local/scanner.mjs).
As dependências npm foram instaladas com `npm ci` dentro das imagens Node 22;
as versões da aplicação seguem `package-lock.json`.

Dados persistem nos volumes `cvg-diagnostic-local_postgres-data`,
`cvg-diagnostic-local_storage-data` e `cvg-diagnostic-local_clamav-data`.
Segredos e certificados privados ficam em `.data/local-deploy`, ignorado pelo
Git e excluído do contexto de build Docker. Aplicação e worker recebem
somente a credencial de runtime do banco; o papel de migração é separado.

## Operação

Executar na raiz deste repositório. Usar sempre o nome e os arquivos abaixo
para operar exclusivamente esta instalação.

```bash
# Iniciar novamente, preservando banco e anexos; não repetir bootstrap.
docker compose -p cvg-diagnostic-local -f docker-compose.local.yml \
  --env-file .data/local-deploy/stack.env up -d --no-build

# Estado e logs.
docker compose -p cvg-diagnostic-local -f docker-compose.local.yml \
  --env-file .data/local-deploy/stack.env ps -a
docker compose -p cvg-diagnostic-local -f docker-compose.local.yml \
  --env-file .data/local-deploy/stack.env logs --tail 50 app worker

# Parar apenas este projeto, preservando seus dados.
docker compose -p cvg-diagnostic-local -f docker-compose.local.yml \
  --env-file .data/local-deploy/stack.env stop

# Reconstruir as imagens após alterações no código, depois iniciar novamente.
docker compose -p cvg-diagnostic-local -f docker-compose.local.yml \
  --env-file .data/local-deploy/stack.env build app migrate
```

Os serviços usam `restart: unless-stopped`; o Docker já está habilitado para
iniciar com a máquina. Um serviço parado por `stop` permanece parado até
novo `up` ou `start`. Não usar `down -v` para manutenção: esse comando apaga
os volumes desta instalação.

## Verificação executada

```bash
curl --cacert .data/local-deploy/certs/ca.crt \
  https://localhost:18443/api/v1/readyz
python3 deploy/local/smoke.py
```

O smoke realiza duas tentativas com credenciais sintéticas inválidas e um
login ADMIN válido; repetir somente com orçamento disponível no limitador
por cliente. A verificação de containers preexistentes exige os mesmos nomes
em execução e as mesmas portas, e registra separadamente mudanças de ID/início
contra o inventário. Usar `python3 deploy/local/smoke.py --strict-baseline`
para também reprovar mudanças de ID/início. O inventário não atribui autoria
das mudanças; operações concorrentes precisam ser investigadas.

Evidência de 03/10/2026:

- Build runner/ops concluído; runtime Node `22.23.3`.
- Migrations `001`–`012`, grants, bucket e bootstrap concluídos.
- App, worker, PostgreSQL, MinIO, scanner e ClamAV saudáveis.
- Login e sessão pelo HTTPS: 200; dashboard ADMIN renderizado no Chromium,
  sem erros de execução no navegador.
- MinIO: escrita, leitura com comparação do conteúdo e remoção apenas do
  objeto sintético criado pelo smoke.
- ClamAV `1.5.4`, assinaturas atualizadas: conteúdo limpo aceito, EICAR
  `QUARANTINED`, chamada sem autorização 401, checksum incorreto 400 e
  divergência de MIME em quarentena.
- Proxy: dois `X-Forwarded-For`/`X-Real-IP` forjados, `198.51.100.17` e
  `203.0.113.23`, resultaram em incremento de 2 nos mesmos buckets de
  cliente, par e falhas. Os logs correlacionados do Caddy registraram o peer
  real `172.31.0.1` (gateway Docker para a conexão originada neste host);
  nenhum contador dos IPs forjados foi criado ou incrementado.
- Às 11:14 UTC, os 35 containers preexistentes conservavam IDs, horários de
  início e portas. Na checagem final, API, worker, SPA e Redis do projeto
  `cvg-his-piloto` tinham novos IDs/inícios, estavam saudáveis e mantinham as
  mesmas portas; os outros 31 continuavam sem alteração. Os comandos desta
  instalação operaram somente `cvg-diagnostic-local`. Apenas
  `127.0.0.1:18443` foi publicado pelo novo projeto.

Resultados detalhados em `.data/local-deploy/evidence/smoke.json`,
`.data/local-deploy/evidence/browser-smoke.json` e
`.data/local-deploy/evidence/admin-dashboard.png`. Esses arquivos são locais,
ignorados pelo Git e não existem em um checkout novo.
Logs de build: `/tmp/cvg-diagnostic-local-ops-build.log` e
`/tmp/cvg-diagnostic-local-runner-build.log`.

Esta evidência cobre a instalação local e seu proxy. O benchmark de carga
HTTP/SSE do PROD-110 continua pendente; uma futura borda institucional,
inclusive CDN ou balanceador adicional, precisa repetir o teste de
[identidade do cliente](DEPLOYMENT.md#51-identidade-do-cliente-e-x-forwarded-for-forjado).
