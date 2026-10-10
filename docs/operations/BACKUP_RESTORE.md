# Backup and restore

**Knowledge status:** `DECISION/PROPOSAL` operacional; RPO/RTO e retenção aguardam aprovação de TI/gestão.

**AAA-2:** [barra](../build/AAA_2_QUALITY_BAR.md) · [plano](../build/AAA_2_EXECUTIVE_PLAN.md) · [roadmap](../build/AAA_2_ROADMAP.md) · [backlog](../build/AAA_2_BACKLOG.md) · [auditoria de 05/09/2026](../RELATORIO_AUDITORIA_2026-09-05.md)

## Current audit evidence (05/09/2026)

O contrato local de manifesto/checksum/plano dry-run está registrado no packet [`aaa2-recovery-local-20260905.md`](../../.orchestrate/evidence/aaa2-recovery-local-20260905.md). O packet AAA-2 [`aaa2-postgres-local-20260905.md`](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md) permanece histórico e registra uma execução anterior em cluster PostgreSQL 16.15 descartável, `db:smoke` e `db:restore:smoke` direto. O packet V2 [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md) registra a execução atual 30/30 em cluster efêmero, incluindo migration 010, projection/read/reconciliation, `EXPLAIN` estrutural e wake-up PostgreSQL real; isso não é um restore. O packet browser production-like acrescenta um banco e serviços S3/scan sintéticos descartáveis, mas também não é um restore. Restore de object storage, metadados reais de chaves, aplicação restaurada, RPO/RTO aprovado e evidência de ambiente produtivo continuam ausentes. Este runbook permanece proposta operacional e não sustenta readiness de produção.

## 1. Scope

Backup must cover PostgreSQL data, object storage attachments, encryption/key metadata required to decrypt, configuration needed to rebuild and documented external references. The local manifest contract records these categories and marks uncaptured object inventory as `NOT_CAPTURED`; it does not collect provider data automatically. A database-only backup is insufficient for released result attachments. Clinical records archived after 24 months (`cvg_clinical_archive`, `cvg_clinical_archive_batches`; [CLINICAL_ARCHIVE](CLINICAL_ARCHIVE.md)) live in PostgreSQL, so they are part of the database backup and of its restore; their attachment objects stay in object storage until the legal-period purge.

## 2. Proposed pilot targets

`ASSUMPTION/PROPOSED`: RPO ≤ 15 minutes and RTO ≤ 4 hours for pilot. TI/management must approve or replace these targets before production.

## 3. Estratégia: três camadas e uma cópia externa

O PostgreSQL roda no servidor do hospital (D11) e a meta é RPO 15 min e RTO 4 h (D2). Nenhuma camada sozinha cobre isso, por isso o Compose de produção mantém três, mais a cópia para fora do prédio:

| Camada | O que faz | Onde fica | Cadência | Serve para |
| --- | --- | --- | --- | --- |
| 1. Dump lógico | `pg_dump` em formato custom, validado com `pg_restore --list`, como o papel de runtime | `cvg-backups` (`cvg-*.dump`) | diária (`BACKUP_INTERVAL_SECONDS`) | restaurar um banco inteiro sem WAL, comparar dados, migrar de versão |
| 2. Backup base físico | `pg_basebackup` (tar+gzip, `--checkpoint=fast`, `--wal-method=none`) como o papel `cvg_backup` | `cvg-backups/base/<UTC>/` | diária | ponto de partida do PITR |
| 3. WAL contínuo | `archive_command` copia cada segmento fechado, de forma atômica, para `cvg-wal-archive`; `archive_timeout` força um segmento a cada `WAL_ARCHIVE_TIMEOUT_SECONDS` (300 s) | `cvg-wal-archive` | contínua, no máximo 5 min | recuperar até qualquer instante depois do backup base |
| Cópia externa | serviço `offsite` (rclone) copia (sem nunca apagar nem sobrescrever no destino) o WAL, os dumps e os backups base para `OFFSITE_RCLONE_REMOTE` | fora do prédio | a cada `OFFSITE_SHIP_INTERVAL_SECONDS` (300 s) | desastre no servidor ou no prédio |
| 4. Bucket de anexos (PROD-514, modo on-prem) | o mesmo `offsite` copia os objetos do bucket (`OFFSITE_BUCKET_SOURCE`, remoto `minio` definido pelo overlay) para `<destino>/objects`, write-once | fora do prédio | a cada ciclo do `offsite` | perda do volume `cvg-storage` ou do servidor; o banco guarda as chaves, o destino guarda os bytes |

Detalhes que importam:

- **Papel `cvg_backup`.** O `pg_basebackup` abre uma conexão de replicação, e `REPLICATION` nunca pode ficar no papel de runtime (a aplicação comprometida passaria a ler todo o WAL). O `migrate` (`scripts/db-roles.ts`) cria `cvg_backup` com `LOGIN REPLICATION` e `pg_read_all_data` quando `POSTGRES_BACKUP_PASSWORD` está definido; o dump continua usando o papel de runtime, sem credencial administrativa no container `backup`. Uma regra dedicada em `deploy/backup/pg_hba.conf` (`host replication cvg_backup ... scram-sha-256`) é a única abertura de replicação. Sem `POSTGRES_BACKUP_PASSWORD` não há backup base nem PITR; o dump diário segue funcionando.
- **Atomicidade e repetição.** `deploy/backup/archive-wal.sh` copia para um nome temporário e renomeia; recusa sobrescrever um segmento diferente e retorna não-zero em qualquer dúvida, o que faz o PostgreSQL guardar o WAL e tentar de novo. Um volume cheio ou um erro de cópia aparece em `pg_stat_archiver.failed_count` e enche o disco do `pg_wal`: é alerta, não perda silenciosa.
- **Retenção.** O `backup` apaga dumps e backups base com mais de `BACKUP_RETENTION_DAYS` (14), sempre preservando o backup base mais recente, e apaga WAL somente anterior ao primeiro segmento que o backup base retido mais antigo exige (lido do `backup_label`). Na cópia externa, o WAL é enviado com `rclone copy` (nunca apaga no destino: um erro de poda local não chega lá) e dumps e backups base também com `rclone copy --ignore-existing`: o envio **nunca apaga nem sobrescreve nada no destino** (os artefatos nascem prontos e nunca mudam: o dump só é renomeado de `.partial` depois do `pg_restore --list` e o backup base fica num diretório com carimbo; um arquivo alterado no lugar, por exemplo cifrado por ransomware com o mesmo nome e data nova, não substitui a cópia boa). Além disso, o ciclo é **recusado** (`offsite.refused`, `lastResult` `error`, saída diferente de zero em `--once`) quando `/backups` não tem um dump (`cvg-*.dump`) ou um `base/<carimbo>/base.tar.gz` não vazio com idade de no máximo `OFFSITE_MAX_BACKUP_AGE_SECONDS` (padrão 2 × `BACKUP_INTERVAL_SECONDS`, 172800 s); um `/backups` vazio ou ausente por engano falha em vez de passar por backup válido. A retenção no destino (`dumps/` e `wal/`) é uma regra de ciclo de vida do próprio destino (por exemplo, expirar objetos com mais de `BACKUP_RETENTION_DAYS` + 2 dias, sempre com margem de pelo menos 2 × o intervalo de backup, para que nenhuma regra apague o backup base mais recente antes de existir o próximo) ou um passo separado do operador, que nunca remove o backup base mais recente nem o WAL posterior a ele.
- **Bucket de anexos.** Os objetos são imutáveis (um `PUT` por anexo, chave com token de reivindicação) e o versionamento do bucket (PROD-307) guarda a versão anterior de qualquer exclusão por `STORAGE_NONCURRENT_VERSION_DAYS`. A cópia externa leva só a versão corrente, com `rclone copy --ignore-existing`: um objeto apagado no servidor (expurgo, engano ou ataque) continua no destino, e um objeto alterado no lugar não substitui a cópia. Antes de copiar, o `offsite` lista o bucket (`rclone size`): se não conseguir (MinIO parado, credencial trocada, nome errado), o ciclo é recusado com `bucket source unreachable`; WAL e dumps ainda saem. O RPO do bucket é o intervalo do `offsite` (300 s). Retenção de `objects/` no destino é regra do destino, com prazo igual ao legal. **Limite:** a recusa só detecta bucket inacessível; um bucket vazio é aceito (é o estado de uma instalação nova), e exigir pelo menos um objeto quando o banco tem anexos precisaria consultar o banco, o que o `offsite` não faz. A conferência de que o destino tem os objetos que o banco referencia é o ensaio de restore (§4.5).
- **Espaço.** Um segmento tem 16 MB mesmo quando fechado por `archive_timeout`: até 288 por dia, cerca de 4,6 GB/dia e 65 GB em 14 dias para o WAL, mais dumps e backups base. Dimensione o disco do servidor e o destino com essa conta (o tamanho real depende da escrita; um sistema quase parado fecha menos segmentos porque o PostgreSQL só troca de segmento se houve escrita).
- **Compressão não é feita no arquivamento** para que `restore_command` seja um `cp`; se o destino cobrar por volume, habilite compressão no destino ou troque o `archive_command` por uma versão que comprima e ajuste a `restore_command` de `scripts/restore-pitr.sh`.
- **Volume novo.** `deploy/backup/postgres-entrypoint.sh` cria `/wal-archive` com o dono certo antes de entregar ao entrypoint oficial.
- **Dump sob demanda:** `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps backup --once` faz dump + backup base + poda. Mantenha `--no-deps`: sem ele o Compose reaplica o `migrate` antes da cópia.

### 3.1 Cálculo de RPO e RTO

- **RPO nominal.** Pior caso entre o commit e a chegada fora do prédio = `archive_timeout` (300 s, o segmento que contém o commit só fecha depois disso) + `OFFSITE_SHIP_INTERVAL_SECONDS` (300 s) = **600 s (10 min)**, dentro do orçamento de 15 min; os 5 min restantes absorvem a duração do envio e uma tentativa que falhou. Se o envio atrasar além de 3 intervalos, o `healthcheck` do `offsite` fica `unhealthy` (§3.3) e o orçamento está estourado.
- **O que o RPO não cobre.** Perda do servidor e do volume `cvg-wal-archive` ao mesmo tempo perde o que ainda não saiu (até 10 min). Perda só do volume do banco é recuperável sem perda além do último segmento fechado (até 5 min), porque o arquivo local continua inteiro.
- **RTO.** Soma de: (a) providenciar o servidor ou o volume (depende do hospital, domina o orçamento de 4 h), (b) baixar do destino o backup base mais recente e o WAL (tamanho do banco + WAL desde o backup base ÷ banda do link), (c) o replay (medido abaixo, segundos para centenas de MB), (d) subir `migrate`, `app`, `worker` e `proxy` e rodar a verificação (§4.3). Os itens (a) e (b) só podem ser medidos no servidor e no destino reais.

### 3.2 Copiar um dump manualmente

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps \
  --entrypoint sh backup -c 'ls -1t /backups/cvg-*.dump | head -1'
docker compose -f docker-compose.prod.yml --env-file .env.production cp \
  backup:/backups/<arquivo>.dump ./<arquivo>.dump   # exige o serviço backup em execução
```

Depois mova o arquivo para um armazenamento cifrado fora da máquina e registre o `sha256sum`. Com o serviço `offsite` ativo isso já acontece sozinho; a cópia manual serve a mudanças de servidor e a auditorias.

### 3.3 Cópia externa: ativar, monitorar, falhar

1. Copie `deploy/backup/rclone.conf.example` para `deploy/backup/rclone.conf` (ignorado pelo git, `chmod 600`) e preencha o remoto real (S3/MinIO ou SFTP). Prefira uma credencial que escreva no caminho e não apague objetos, quando o destino permitir.
2. Cifra obrigatória (D-051): a senha e o sal do remoto `crypt` são os arquivos `offsite_crypt_password` e `offsite_crypt_salt` de `SECRETS_DIR` (`scripts/secrets-init.sh`; cópia no cofre, sem eles a cópia externa é ilegível). No arquivo de ambiente: `OFFSITE_RCLONE_REMOTE=offsitecrypt:` e `OFFSITE_CRYPT_REMOTE=<remoto>:<caminho>` (por exemplo `s3:cvg-offsite/hospital-a`); se o `rclone.conf` estiver em outro caminho, `OFFSITE_RCLONE_CONFIG`. Opcionalmente `OFFSITE_MAX_BACKUP_AGE_SECONDS` (padrão 2 × `BACKUP_INTERVAL_SECONDS`). Um destino que não seja `crypt` é recusado, salvo `OFFSITE_ALLOW_PLAINTEXT=true` por decisão registrada do hospital.
3. Teste o destino antes pelo helper que carrega os segredos (`docker compose ... run --rm --no-deps offsite sh /opt/backup/rclone-with-secrets.sh lsd offsitecrypt:`) e suba: `docker compose ... up -d offsite`.
4. No modo on-prem, o overlay já define `OFFSITE_BUCKET_SOURCE=minio:<bucket>`; num S3 gerenciado, defina um remoto de leitura no `rclone.conf` e `OFFSITE_BUCKET_SOURCE=<remoto>:<bucket>` para o bucket entrar na cópia (`objects` no status).
5. Sem `OFFSITE_RCLONE_REMOTE`, o serviço registra `{"event":"offsite.disabled"}` e fica ocioso; a aplicação sobe do mesmo jeito, mas nenhum backup sai do servidor. Isso precisa ser uma decisão registrada, não um esquecimento.
6. A cada ciclo o serviço grava `/backups/offsite-status.json` com `lastShippedAt`, `lastShippedEpoch`, `lastAttemptAt`, `lastResult` (`ok`, `error`, `disabled`), `walSegments`, `bytes` (aproximado, em blocos de 1 KiB), `objects` (objetos no bucket de anexos, 0 sem `OFFSITE_BUCKET_SOURCE`) e, quando o ciclo é recusado, `reason`. Um ciclo recusado (`{"event":"offsite.refused","reason":...}` no log de erro) ainda copia o WAL, mas não conta como sucesso: sem backup válido recente em `/backups` o `healthcheck` fica vermelho depois de 3 intervalos. Como o envio nunca apaga, configure no destino a regra de ciclo de vida de `dumps/` e `wal/` descrita na retenção (§3, margem de pelo menos 2 × o intervalo de backup). `deploy/backup/check-offsite.sh` lê esse arquivo e sai com código diferente de zero quando o último **sucesso** é mais velho que 3 × `OFFSITE_SHIP_INTERVAL_SECONDS` (ou o arquivo não existe): é o `healthcheck` do Compose e o comando do runbook (`docker compose ... exec offsite sh /opt/backup/check-offsite.sh`). Não existe métrica Prometheus para isso (o Hub não enxerga o volume), então o alerta é o estado `unhealthy` do container, que o monitoramento do host precisa observar (PROD-513); veja [INCIDENT_RUNBOOKS.md](INCIDENT_RUNBOOKS.md#backup-falho-ou-cópia-externa-parada).

## 4. Runbook de restore

Escolha o ponto de recuperação e o escopo (banco, arquivos, configuração) antes de qualquer comando destrutivo:

1. declarar o incidente e congelar a escrita se a integridade for incerta;
2. identificar o ponto de recuperação: um instante UTC (ex.: um minuto antes do erro, da deleção ou do ransomware) ou "o mais recente";
3. escolher o caminho: **PITR** (§4.1) quando se conhece o instante ou o disco do banco foi perdido; **dump** (§4.2) para um banco lógico perdido sem WAL;
4. restaurar em alvo isolado e verificar (§4.3) antes de qualquer cutover;
5. restaurar o armazenamento de objetos pelo procedimento do provedor (§1: o restore do PostgreSQL não cobre anexos; o PROD-514 ainda não cobre o S3);
6. comparar RPO/RTO obtidos com o orçamento e registrar as lacunas;
7. aprovar cutover ou retorno; preservar a evidência do incidente.

### 4.1 Restore point-in-time (PITR)

`scripts/restore-pitr.sh` (`npm run db:restore:pitr -- ...`) monta o cluster em um container `postgres:16-alpine` **descartável**, a partir de um backup base e do WAL; nunca toca o volume de produção. Recusa um `--data` que não esteja vazio.

```bash
# 1. Traga do destino externo (ou do volume) o backup base mais recente anterior ao alvo e o WAL inteiro.
rclone copy <remoto>:<caminho>/dumps/base  /restore/base
rclone copy <remoto>:<caminho>/wal         /restore/wal

# 2. Restaure até o instante desejado (UTC com sufixo Z, ou com deslocamento) ou até o fim do arquivo.
npm run db:restore:pitr -- \
  --base /restore/base/<UTC-do-backup-base> --wal /restore/wal \
  --target-time 2026-10-08T14:29:00Z --data /restore/pgdata --port 55432 --user "$POSTGRES_USER"
#   ou: --latest   (reproduz todo o WAL disponível)

# 3. Saída: {"event":"pitr.restored","elapsedSeconds":..,"lastReplayedLsn":"..","lastReplayedTimestamp":".."}
#    O container fica de pé em 127.0.0.1:55432 para inspeção; remova com: docker rm -f <nome impresso>
```

Regras do alvo: use um backup base **anterior** ao instante (o script não escolhe sozinho: o `backup_label` e a pasta `<UTC>` dizem quando ele foi tirado); `--target-time` sem fuso é recusado; com `--latest` o PostgreSQL reproduz o arquivo até o último segmento e promove sozinho. Se o alvo for anterior ao fim do backup base, o PostgreSQL aborta com erro claro no log (use um backup base mais antigo). O script só termina quando `pg_is_in_recovery()` vira falso.

**Colocar o resultado em produção** (depois de verificar em §4.3, com o incidente aprovado):

```bash
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
$DC stop proxy app worker backup offsite postgres
# Guarda o conteúdo atual em previous-pgdata.tgz e troca pelo cluster restaurado (ensaiado em 08/10/2026).
# Nunca apague o tgz antes de a restauração estar aprovada. <projeto> é o prefixo do Compose (docker volume ls).
docker run --rm -v <projeto>_cvg-postgres:/old -v /restore:/new --entrypoint sh postgres:16-alpine -c \
  'tar -czf /new/previous-pgdata.tgz -C /old . && find /old -mindepth 1 -delete && cp -a /new/pgdata/. /old/ \
   && sed -i "/^restore_command/d;/^recovery_target/d" /old/postgresql.auto.conf && chown -R postgres:postgres /old'
$DC up -d
```

O WAL novo nasce em uma linha do tempo nova (`00000002...`), então não colide com o arquivo antigo; mantenha o volume `cvg-wal-archive` e tire um backup base novo logo após subir (`backup --once`), porque os backups base antigos continuam válidos só para a linha do tempo anterior ao ponto de recuperação.

### 4.2 Restaurar um dump do Compose (ensaiado em 06/10/2026)

Ensaiado em uma cópia isolada da pilha de produção: o banco foi apagado, o dump agendado mais recente restaurado e `readyz`, login, contagens de linhas, donos das tabelas e a trava append-only de `audit_events` foram verificados depois. O dump é gravado com `--no-owner --no-privileges`; ele é restaurado como o papel administrativo e o `migrate` devolve cada objeto ao papel de migração e reaplica as permissões do runtime. Restaura só o banco; anexos do armazenamento de objetos têm restore próprio.

```bash
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
$DC stop proxy app worker backup offsite
# Destrutivo: só depois de o responsável pelo incidente aprovar o ponto de recuperação.
$DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""'
$DC run --rm --no-deps -T --entrypoint sh -e PGUSER="$POSTGRES_USER" -e PGPASSWORD="$POSTGRES_PASSWORD" backup -c \
  'pg_restore --no-owner --no-privileges --exit-on-error -d "$PGDATABASE" /backups/<arquivo>.dump'
$DC run --rm migrate      # donos, permissões do runtime, checksums das migrations
$DC up -d
curl -fsS "https://$APP_DOMAIN/api/v1/readyz"
```

`POSTGRES_USER` e `POSTGRES_PASSWORD` são as credenciais administrativas do `.env.production` (exporte antes). Toda migration deve responder "já aplicada"; erro de checksum significa que o dump vem de outra versão e a tag de imagem correspondente deve ser usada.

### 4.3 Verificação depois de qualquer restore

**Reconciliação banco × bucket (D-062):** `npm run attachments:reconcile` (mesmo ambiente do worker: `APP_DATA_MODE=postgres`, `DATABASE_URL`, `STORAGE_*`) prova que todo anexo finalizado ou arquivado tem o seu objeto e que nenhum objeto do bucket ficou sem anexo; imprime um JSON (`attachments.reconciled` ou `attachments.divergent`, com os ids dos anexos sem objeto e a contagem de órfãos) e sai com 1 em qualquer divergência. Um restore de banco e de bucket só está aceito com essa saída limpa. Exceção a ler com cuidado: depois de um **PITR para um instante anterior** ao último estado, o bucket (restaurado da cópia write-once) pode ter objetos de anexos gravados **depois** do ponto de recuperação; eles aparecem como órfãos e são **investigação**, não perda — anote-os no incidente, não os apague antes de decidir o ponto de recuperação final. Um anexo **sem objeto** é sempre perda. Em seguida: checksums e contagens (solicitações, resultados, anexos), versão do schema, `/readyz`, login, visão de uma solicitação com escopo, resultado/versão/linha do tempo e fila de notificações; compare com os totais anotados antes do incidente e registre horário do último commit recuperado (o `lastReplayedTimestamp` do PITR) para medir a perda real.

### 4.4 Ensaio automatizado (`npm run db:backup:drill`)

`scripts/backup-drill.sh` repete o ciclo inteiro em um projeto Compose descartável (`docker-compose.prod.yml` + `docker-compose.pitr-drill.yml`; sobem só `postgres`, `migrate`, `backup` e `offsite`, com destino `:local:` do rclone): cria a carga e marcadores `m1..m4` com instantes, define o alvo entre `m2` e `m3`, força `pg_switch_wal()`, espera o arquivamento e a cópia externa, restaura **a partir da cópia externa** com `restore-pitr.sh` (alvo e `--latest`), confere os marcadores (`m1,m2` e `m1,m2,m3,m4`), imprime um JSON com RPO e RTO e remove tudo (`down -v`). Variáveis: `DRILL_PROJECT`, `DRILL_PORT`, `DRILL_SHIP_INTERVAL_SECONDS`, `DRILL_ROW_COUNT`. Exige Docker, a imagem `ops` (é construída na primeira execução) e as imagens `postgres:16-alpine` e `rclone/rclone`.

### 4.5 Restaurar o bucket de anexos a partir da cópia externa

Quando o volume `cvg-storage` (ou o servidor) se perde. O banco restaurado (§4.1 ou §4.2) tem as chaves dos anexos; os bytes vêm de `<OFFSITE_RCLONE_REMOTE>/objects`.

```bash
# 1. Suba o storage vazio e deixe o storage-init endurecer o bucket (versionamento, SSE, policy, ciclo de vida).
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml --env-file .env.production up -d storage storage-init
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml --env-file .env.production logs storage-init   # storage.hardened, problems: []
# 2. Copie do destino cifrado para o bucket com o serviço storage-restore (usuário do app: o da cópia externa só lê).
#    Nada é apagado em lugar nenhum.
docker compose -f docker-compose.prod.yml -f docker-compose.onprem.yml -f docker-compose.secrets.yml --env-file /etc/cvg-hub/prod.env \
  --profile restore run --rm --no-deps storage-restore copy offsitecrypt:objects "minio:$STORAGE_BUCKET" --ignore-existing
# 3. Confira contagem e integridade contra o destino, o endurecimento do bucket restaurado e os usuários.
docker compose ... --profile restore run --rm --no-deps storage-restore check offsitecrypt:objects "minio:$STORAGE_BUCKET" --one-way
docker compose ... run --rm --no-deps storage-init node_modules/.bin/tsx scripts/init-storage.ts --verify
docker compose ... run --rm --no-deps --entrypoint sh storage-iam /usr/local/bin/cvg-storage-iam-verify
# 4. Suba app e worker e abra um anexo de cada setor pela tela (download passa por checksum e scanStatus).
```

O destino pode ter objetos que o expurgo já apagou do servidor: eles voltam com o `copy`, e o banco restaurado não os referencia. Se o restore for posterior a um expurgo, rode `npm run runtime:archive -- --dry-run --purge` para ver o que seria removido de novo e aplique o expurgo quando o jurídico confirmar. Ensaio reproduzível: `npm run storage:backup:drill` (medidas no §5).

### 4.6 Ensaio completo: banco e anexos perdidos juntos (`npm run restore:drill`)

`scripts/full-restore-drill.sh` é o cenário do PROD-514 inteiro, num projeto Compose descartável com os overlays `prod + onprem + secrets + storage-drill` (segredos em arquivo, destino externo `crypt`): sobe `postgres`, `migrate`, `backup`, `storage`, `storage-init`, `storage-iam` e `offsite`; cria o primeiro administrador (`bootstrap`); grava `DRILL_ATTACHMENT_COUNT` anexos pelo **store e file store da aplicação** (`scripts/drill-seed-attachments.ts`, rodando com a definição do serviço `worker`) e reconcilia linhas e objetos; força a troca de WAL e espera WAL, dump e objetos chegarem à cópia externa (**RPO medido** = última gravação → cópia externa); destrói os volumes de PostgreSQL, backups locais, arquivo de WAL e storage; baixa a cópia externa pelo remoto `crypt`, restaura o banco até o fim do arquivo (`restore-pitr.sh --latest`) e o bucket num bucket novo endurecido (`storage-restore`, usuário do app); reconcilia o banco restaurado contra o bucket restaurado (**RTO medido** = baixar + banco + bucket + reconciliação); e prova que a reconciliação detecta um objeto removido e um objeto órfão. O JSON final traz `rpo`, `rto`, `reconciliation` e as contagens. Nunca aponte para um projeto de produção: o script recusa `cvg-hub`, `cvg-prod`, `cvg-hml` e `cvg-diagnostic-local` e roda `down -v` no projeto do ensaio.

## 5. Cadência dos ensaios e evidência

- **Mensal:** `npm run restore:drill` (banco e anexos juntos, §4.6) e `npm run db:backup:drill` em máquina de homologação (ou na do hospital, em projeto Compose separado, nunca sobre produção) e conferência de que `check-offsite.sh` está verde há 30 dias.
- **Trimestral e antes da entrada em produção:** restore completo cronometrado no servidor real a partir do **destino externo** (sem os volumes locais), com o PITR do §4.1, a subida da aplicação e a verificação do §4.3, assinado pelo responsável. Esse ensaio mede o que o laboratório não mede: provisionamento, banda do link e o S3 (PROD-514).
- Evidência de cada ensaio: ID e horário do backup base, alvo, duração, JSON do drill, contagens e o responsável. Nunca execute restore destrutivo sobre produção.

### Evidência medida (2026-10-08, laboratório local)

Ensaiado com `scripts/backup-drill.sh` no Docker 29 / PostgreSQL 16.15 (`postgres:16-alpine`), `rclone/rclone:1.71.2`, destino `:local:` e intervalo de envio de 15 s. O servidor e o destino externos do hospital ainda não existem; estes números provam o mecanismo, não o RTO de produção.

| Medida | Carga pequena (200 mil linhas) | Carga maior (3 milhões de linhas) |
| --- | --- | --- |
| Tamanho do banco no momento do ensaio | 35 MB | 381 MB |
| Backup base (tar.gz, tirado antes da carga) | 4,3 MB | 4,3 MB |
| Segmentos de WAL reproduzidos | 4 | 36 (576 MB) |
| **RTO: restore PITR até o alvo** (cópia externa já baixada) | **1 s** | **6 s** |
| RTO: restore `--latest` | 1 s | 6 s |
| Marcadores no alvo / com `--latest` | `m1,m2` / `m1,m2,m3,m4` | `m1,m2` / `m1,m2,m3,m4` |
| Linhas de carga restauradas | 200.000 de 200.000 | 3.000.000 de 3.000.000 |
| RPO: alvo até o último WAL arquivado | 3 s | 4 s |
| RPO: arquivamento até a cópia externa | 12 s | 15 s |
| Ensaio completo (subir, carregar, copiar, restaurar duas vezes, verificar) | 36 s | 65 s |

Leitura honesta: o RPO nominal é 600 s (300 de `archive_timeout` + 300 de envio) e o ensaio, com `pg_switch_wal()` forçado e envio de 15 s, só prova que o caminho funciona e que o atraso de envio acompanha o intervalo. O RTO medido (segundos) é só o replay, sem baixar do destino e sem provisionar o servidor; a janela de 4 h é dominada por esses dois itens, que dependem do hospital.

### Evidência medida do bucket de anexos (2026-10-09, laboratório local)

`npm run storage:backup:drill` com o overlay on-prem (MinIO compilado da fonte `7aac2a2`, `rclone/rclone:1.71.2`, destino `:local:`, envio a cada 15 s), em projeto Compose descartável:

| Medida | Valor |
| --- | --- |
| Endurecimento pelo `storage-init` | versionamento `Enabled`, SSE `AES256`, objeto de prova cifrado, policy ausente, leitura anônima `403`, 1 regra de ciclo de vida (versões não correntes, 30 dias) |
| Objetos gravados pela API S3 | 200 × 64 KiB (12,5 MB) |
| Cópia externa completa (`objects: 200`, `check-offsite.sh` ok) | 12 s depois do início do upload |
| Perda simulada | `docker volume rm` do `cvg-storage`; bucket novo vazio e endurecido |
| **Restore dos 200 objetos a partir da cópia externa** | **1 s** |
| Verificação | `rclone check` sem divergência; `storage.verified` no bucket restaurado; leitura anônima `403` |
| Ensaio completo | 35 s |

O ensaio prova o mecanismo (write-once, recusa sem fonte, restore íntegro num bucket endurecido), não o RTO de produção: baixar do destino real e provisionar o servidor dependem do hospital (PROD-514).

Repetido em 09/10/2026 depois de D-051 (segredos em arquivo, usuários de menor privilégio, destino `crypt`): 200 objetos, cópia externa 14 s (207 arquivos cifrados no destino cru, nenhum nome original nem byte em claro), restore pelo `storage-restore` com o usuário do app em 1 s, tentativa de restore com o usuário só leitura negada, `storage.verified` e `cvg-storage-iam-verify` 17/17 depois do restore; ensaio inteiro em 36 s. O ensaio do PITR (`npm run db:backup:drill`) passou a enviar e a restaurar pelo mesmo remoto cifrado.

### Evidência medida do ensaio completo banco + anexos (2026-10-10, laboratório local)

`npm run restore:drill` (§4.6) em projeto Compose descartável nesta máquina: overlays `prod + onprem + secrets + storage-drill`, segredos em arquivo, MinIO `7aac2a2`, `rclone/rclone:1.71.2`, destino `crypt` sobre `:local:`, envio a cada 15 s. Anexos gravados pelo store e file store da aplicação (uma linha de aggregate e um objeto cada), primeiro administrador pelo `bootstrap`.

| Medida | 50 anexos × 64 KiB | 500 anexos × 256 KiB |
| --- | --- | --- |
| Banco no momento da perda | 10,7 MB | 11,0 MB |
| Reconciliação antes da perda | 50 linhas = 50 objetos | 500 = 500 |
| **RPO medido: última gravação → WAL, dump e objetos na cópia externa** | **10 s** | **8 s** |
| Perda simulada | volumes `cvg-postgres`, `cvg-backups`, `cvg-wal-archive` e `cvg-storage` removidos | idem |
| Baixar a cópia externa pelo remoto `crypt` | 3 s | 2 s |
| Restore do banco até o fim do arquivo (4 segmentos de WAL) | 2 s | 8 s |
| Bucket novo endurecido + restore dos objetos (usuário do app) | 20 s | 11 s |
| Reconciliação banco restaurado × bucket restaurado | 1 s, `ok`, 0 faltantes, 0 órfãos | 0 s, `ok`, 0 faltantes, 0 órfãos |
| **RTO medido (baixar + banco + bucket + reconciliar)** | **26 s** | **21 s** |
| Controles negativos | objeto apagado → `attachments.divergent` com o id do anexo; objeto estranho → `orphanObjects: 1` | idem |
| Ensaio completo | 107 s | 140 s |

Leitura honesta: o RPO nominal continua 600 s (`archive_timeout` + envio) e o ensaio força a troca de WAL; o RTO mede o mecanismo com volumes locais, não o download do destino real nem a provisão do servidor do hospital. O que o ensaio acrescenta ao PROD-514 é a prova de que **banco e bucket restaurados batem entre si** e de que a reconciliação acusa um objeto a menos ou a mais. O destino, o servidor e o restore cronometrado neles continuam a cargo do hospital (PROD-514 `BLOCKED`).

**Achado colateral (D-057):** este ensaio foi o primeiro a subir o worker de produção com a definição real do serviço e encontrou o worker recusando partir (`SECRET_FILE_UNREADABLE:OUTBOX_HEARTBEAT`): o carregador de segredos lia `OUTBOX_HEARTBEAT_FILE` como se fosse um segredo. Corrigido com allowlist explícita e teste de boot do worker.

## 6. Failure handling

Missing/failed backup is a release/operations alert, not a warning to ignore. Storage unavailable blocks attachment release where required; DB unavailable makes readiness false. Ransomware scenario uses immutable/offline copy and credential rotation. A parada da cópia externa (`offsite` unhealthy) é o alerta de backup falho: siga o runbook [Backup falho ou cópia externa parada](INCIDENT_RUNBOOKS.md#backup-falho-ou-cópia-externa-parada).
