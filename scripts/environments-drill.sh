#!/usr/bin/env bash
# Rehearsal of PROD-301/302/309 (D-051) on this machine: homologation and production SIDE BY SIDE, as on the hospital
# server, each in its own Compose project with its own env file, secrets directory, CA/KMS directory, database, bucket,
# volumes and networks. Starts postgres, migrate, backup, storage, storage-init, storage-iam and offsite of BOTH
# projects (prod + onprem + secrets + storage-drill overlays; app, worker and proxy never start), then proves:
#   (a) every secret reached the containers as a file: migrate (database passwords from files, placeholder expansion),
#       storage-init (root password file), storage-iam (app/offsite secrets), backup (PGPASSWORD_FILE) all succeeded;
#       the env files contain no secret value and `docker compose config` of each project contains none either;
#   (b) isolation: the two projects share no volume and no network; a container of one cannot resolve nor reach the
#       PostgreSQL or the MinIO of the other; buckets and databases have different names;
#   (c) the off-site destination is an rclone crypt remote: the raw destination holds only encrypted names and bytes,
#       the dump is readable through the crypt remote, and a plaintext destination is refused unless allowed;
#   (d) rotation runbook: the runtime password of homologation is rotated (scripts/secrets-init.sh --rotate), migrate
#       re-applies it from the file and the next backup succeeds with the new password;
#   (e) least privilege on both MinIO instances (deploy/minio/iam-verify.sh);
#   prints a JSON summary and tears both projects down.
#
#   npm run environments:drill            # or: bash scripts/environments-drill.sh [--keep]
#
# Environment: DRILL_PROJECT_PREFIX (default cvg-env-drill; projects <prefix>-hml and <prefix>-prod),
# DRILL_SHIP_INTERVAL_SECONDS (default 15), DRILL_IMAGE_PREFIX (images <prefix>-ops/-minio/-mc; default = project prefix).
# Never point it at a production Compose project: it runs `down -v` on both projects.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${DRILL_PROJECT_PREFIX:-cvg-env-drill}"
SHIP_INTERVAL="${DRILL_SHIP_INTERVAL_SECONDS:-15}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT_PREFIX inválido" >&2; exit 2; }
for forbidden in cvg-hub cvg-diagnostic-hub-v2 cvg-diagnostic-local cvg-prod cvg-hml; do
  [[ "$PREFIX" != "$forbidden" && "$PREFIX-hml" != "$forbidden" && "$PREFIX-prod" != "$forbidden" ]] || { echo "recusando o prefixo $PREFIX: use um projeto descartável" >&2; exit 2; }
done

work_dir="$(mktemp -d)"
drill_started="$(date +%s)"
ENVS=(hml prod)
declare -A DC_FILES
cleanup() {
  status=$?
  if [[ "$KEEP" != "true" ]]; then
    for env in "${ENVS[@]}"; do dc "$env" down -v --remove-orphans >/dev/null 2>&1 || true; done
    rm -rf "$work_dir"
  else
    echo "--keep: projetos $PREFIX-hml, $PREFIX-prod e $work_dir mantidos" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

step() { printf '[%ss] %s\n' "$(( $(date +%s) - drill_started ))" "$1" >&2; }
dc() { # env, compose args...
  local env="$1"; shift
  docker compose -p "$PREFIX-$env" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" \
    -f "$ROOT_DIR/docker-compose.secrets.yml" -f "$ROOT_DIR/docker-compose.storage-drill.yml" --env-file "$work_dir/$env/env" "$@"
}
wait_for() { # description, timeout, command...
  local description="$1" limit="$2"; shift 2
  local until=$(( $(date +%s) + limit ))
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) < until )) || { echo "tempo esgotado esperando: $description" >&2; exit 1; }
    sleep 2
  done
}
exited_ok() { # env service
  local id; id="$(dc "$1" ps -aq "$2")"
  [[ -n "$id" && "$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)" == "exited" && "$(docker inspect -f '{{.State.ExitCode}}' "$id")" == "0" ]]
}
status_field() { docker exec "$(dc "$1" ps -q offsite)" sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" /backups/offsite-status.json 2>/dev/null | head -1; }

SECRET_NAMES=(POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_RUNTIME_PASSWORD POSTGRES_BACKUP_PASSWORD SESSION_SECRET TRUST_PROXY_SHARED_SECRET STORAGE_SECRET_KEY MALWARE_SCANNER_API_KEY METRICS_SCRAPE_TOKEN OFFSITE_CRYPT_PASSWORD OFFSITE_CRYPT_SALT)

# One environment = one directory tree, as /etc/cvg-hub/<env>/ on the server.
for env in "${ENVS[@]}"; do
  mkdir -p "$work_dir/$env"
  bash "$ROOT_DIR/scripts/onprem-init.sh" "$work_dir/$env/onprem" >/dev/null 2>&1
  bash "$ROOT_DIR/scripts/secrets-init.sh" "$work_dir/$env/secrets" --allow-empty metrics_scrape_token >/dev/null
  sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=$env.hospital.example|" \
      -e "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=${DRILL_IMAGE_PREFIX:-$PREFIX}|" \
      -e "s|^POSTGRES_DB=.*|POSTGRES_DB=cvg_$env|" \
      -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://storage:9000|" \
      -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=cvg-$env-attachments|" \
      -e "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=cvg-app|" \
      -e "s|^STORAGE_FORCE_PATH_STYLE=.*|STORAGE_FORCE_PATH_STYLE=true|" \
      -e "s|^MALWARE_SCANNER_ENDPOINT=.*|MALWARE_SCANNER_ENDPOINT=https://scanner:9443/scan|" \
      -e "s|^MALWARE_SCANNER_ALLOWED_HOSTS=.*|MALWARE_SCANNER_ALLOWED_HOSTS=scanner|" \
      -e "s|^ONPREM_DIR=.*|ONPREM_DIR=$work_dir/$env/onprem|" \
      -e "s|^SECRETS_DIR=.*|SECRETS_DIR=$work_dir/$env/secrets|" \
      -e "s|^OFFSITE_RCLONE_REMOTE=.*|OFFSITE_RCLONE_REMOTE=offsitecrypt:|" \
      -e "s|^OFFSITE_CRYPT_REMOTE=.*|OFFSITE_CRYPT_REMOTE=/offsite-destination|" \
      -e "s|^OFFSITE_RCLONE_CONFIG=.*|OFFSITE_RCLONE_CONFIG=$ROOT_DIR/deploy/backup/rclone.conf.example|" \
      -e "s|^OFFSITE_SHIP_INTERVAL_SECONDS=.*|OFFSITE_SHIP_INTERVAL_SECONDS=$SHIP_INTERVAL|" \
      "$ROOT_DIR/.env.production.example" > "$work_dir/$env/env"
  chmod 600 "$work_dir/$env/env"
  # (a) no secret value in the env file nor in the rendered configuration.
  for name in "${SECRET_NAMES[@]}"; do
    if grep -qE "^$name=.+" "$work_dir/$env/env"; then echo "$env: $name tem valor no arquivo de ambiente" >&2; exit 1; fi
  done
  rendered="$(dc "$env" config 2>/dev/null)"
  for file in "$work_dir/$env/secrets"/*; do
    value="$(cat "$file")"; [[ -n "$value" ]] || continue
    if grep -qF -- "$value" <<<"$rendered"; then echo "$env: o valor de $(basename "$file") aparece na configuração do Compose" >&2; exit 1; fi
  done
done
step "dois ambientes preparados (arquivos de ambiente sem segredos, segredos só em arquivos)"

for env in "${ENVS[@]}"; do dc "$env" up -d postgres migrate backup storage storage-init storage-iam offsite >&2; done
for env in "${ENVS[@]}"; do
  wait_for "$env: migrate" 600 exited_ok "$env" migrate
  wait_for "$env: storage-init" 180 exited_ok "$env" storage-init
  wait_for "$env: storage-iam" 120 exited_ok "$env" storage-iam
  wait_for "$env: primeiro dump" 180 dc "$env" exec -T backup sh -c 'ls /backups/cvg-*.dump'
  loaded="$(dc "$env" logs --no-log-prefix migrate 2>/dev/null | grep -F '"event":"secrets.loaded"' | head -1)"
  [[ "$loaded" == *POSTGRES_MIGRATION_PASSWORD* && "$loaded" == *MIGRATION_DATABASE_URL* ]] || { echo "$env: o migrate não leu as senhas dos arquivos: $loaded" >&2; exit 1; }
done
step "ambos de pé: migrate, hardening, usuários e primeiro dump concluídos com segredos em arquivo"

# (b) isolation.
vol_hml="$(docker volume ls -q --filter "name=^${PREFIX}-hml_" | sort)"; vol_prod="$(docker volume ls -q --filter "name=^${PREFIX}-prod_" | sort)"
[[ -n "$vol_hml" && -n "$vol_prod" && -z "$(comm -12 <(echo "$vol_hml") <(echo "$vol_prod"))" ]] || { echo "volumes compartilhados ou ausentes" >&2; exit 1; }
net_hml="$(docker network ls -q --filter "name=^${PREFIX}-hml_")"; net_prod="$(docker network ls -q --filter "name=^${PREFIX}-prod_")"
[[ -n "$net_hml" && -n "$net_prod" && "$net_hml" != "$net_prod" ]] || { echo "redes compartilhadas ou ausentes" >&2; exit 1; }
prod_pg="$(dc prod ps -q postgres)"; prod_pg_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$prod_pg")"
if dc hml exec -T backup pg_isready -h "$prod_pg_ip" -t 3 >/dev/null 2>&1; then echo "a homologação alcança o PostgreSQL da produção" >&2; exit 1; fi
if dc hml exec -T backup pg_isready -h "${PREFIX}-prod-postgres-1" -t 3 >/dev/null 2>&1; then echo "a homologação resolve o nome do PostgreSQL da produção" >&2; exit 1; fi
# Bounded: a name of the other project does not resolve on this network, and rclone would otherwise retry for minutes.
if timeout 30 docker exec "$(dc hml ps -q offsite)" sh /opt/backup/rclone-with-secrets.sh lsd "minio:" --s3-endpoint "http://${PREFIX}-prod-storage-1:9000" --contimeout 5s --timeout 5s --retries 1 --low-level-retries 1 >/dev/null 2>&1; then echo "a homologação alcança o MinIO da produção" >&2; exit 1; fi
db_hml="$(dc hml exec -T postgres psql -U cvg -d cvg_hml -Atq -c 'select current_database()')"; db_prod="$(dc prod exec -T postgres psql -U cvg -d cvg_prod -Atq -c 'select current_database()')"
[[ "$db_hml" == "cvg_hml" && "$db_prod" == "cvg_prod" ]] || { echo "bancos inesperados: $db_hml / $db_prod" >&2; exit 1; }
step "isolamento confirmado: volumes, redes, banco e bucket distintos; nenhum alcance cruzado"

# (e) least privilege on both.
for env in "${ENVS[@]}"; do
  dc "$env" run --rm --no-deps -T --entrypoint sh storage-iam /usr/local/bin/cvg-storage-iam-verify 2>/dev/null | grep -qF '"event":"storage_iam.verified"' || { echo "$env: menor privilégio falhou" >&2; exit 1; }
done
step "menor privilégio verificado nos dois MinIO"

# (c) encrypted destination.
for env in "${ENVS[@]}"; do
  shipped() { [[ "$(status_field "$env" lastResult)" == '"ok"' ]]; }
  wait_for "$env: cópia externa" $(( SHIP_INTERVAL * 6 + 60 )) shipped
  offsite="$(dc "$env" ps -q offsite)"
  if docker exec "$offsite" sh -c 'find /offsite-destination -name "*.dump" -o -name "dumps" -o -name "wal" | grep -q .'; then echo "$env: destino cru expõe nomes" >&2; exit 1; fi
  docker exec "$offsite" sh /opt/backup/rclone-with-secrets.sh lsf "offsitecrypt:dumps" 2>/dev/null | grep -q '\.dump$' || { echo "$env: dump não legível pelo crypt" >&2; exit 1; }
  dump_sha="$(docker exec "$(dc "$env" ps -q backup)" sh -c 'sha256sum /backups/cvg-*.dump | head -1 | cut -d" " -f1')"
  if docker exec "$offsite" sh -c 'find /offsite-destination -type f -exec sha256sum {} +' | grep -q "$dump_sha"; then echo "$env: dump em claro no destino" >&2; exit 1; fi
done
# The service's entrypoint is the script itself: the one-shot flag is the whole command (never `sh <script> --once`).
plain_out="$(timeout 120 docker compose -p "$PREFIX-hml" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" -f "$ROOT_DIR/docker-compose.secrets.yml" -f "$ROOT_DIR/docker-compose.storage-drill.yml" --env-file "$work_dir/hml/env" run --rm --no-deps -T -e OFFSITE_RCLONE_REMOTE=:local:/plain-destination -e OFFSITE_CRYPT_PASSWORD_FILE= -e OFFSITE_ALLOW_PLAINTEXT=false offsite --once 2>&1 || true)"
[[ "$plain_out" == *"not a crypt remote"* ]] || { echo "destino em claro não foi recusado: $plain_out" >&2; exit 1; }
step "cópia externa cifrada nos dois ambientes; destino em claro recusado"

# (d) rotation runbook on homologation: runtime password.
old_pw="$(cat "$work_dir/hml/secrets/postgres_runtime_password")"
bash "$ROOT_DIR/scripts/secrets-init.sh" "$work_dir/hml/secrets" --rotate postgres_runtime_password >/dev/null
new_pw="$(cat "$work_dir/hml/secrets/postgres_runtime_password")"
[[ "$old_pw" != "$new_pw" ]]
dc hml run --rm -T migrate >/dev/null 2>&1 || { echo "migrate não reaplicou a senha rotacionada" >&2; exit 1; }
dc hml up -d --force-recreate backup offsite >&2
rotated_backup="$(dc hml run --rm --no-deps -T backup --once 2>&1 | grep -F '"event":"backup.completed"' | tail -1)"
[[ -n "$rotated_backup" ]] || { echo "backup falhou depois da rotação da senha de runtime" >&2; exit 1; }
if dc hml exec -T postgres psql -U cvg -d cvg_hml -Atq -c "select 1" >/dev/null 2>&1 && PGPASSWORD="$old_pw" dc hml exec -T -e PGPASSWORD="$old_pw" backup psql -h postgres -U cvg_runtime -d cvg_hml -Atq -c "select 1" >/dev/null 2>&1; then
  echo "a senha antiga de runtime ainda funciona depois da rotação" >&2; exit 1
fi
step "rotação ensaiada: senha de runtime trocada pelo arquivo, migrate reaplicou, backup novo ok, senha antiga recusada"

printf '{"event":"environments_drill.completed","projects":["%s-hml","%s-prod"],"secretsAsFiles":true,"envFilesWithoutSecrets":true,"isolated":true,"leastPrivilege":true,"encryptedOffsite":true,"plaintextRefused":true,"rotationRehearsed":"postgres_runtime_password","totalSeconds":%s}\n' \
  "$PREFIX" "$PREFIX" "$(( $(date +%s) - drill_started ))"
