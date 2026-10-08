#!/usr/bin/env bash
# Point-in-time restore of the Compose PostgreSQL (PROD-304/PROD-514) into a DISPOSABLE postgres:16-alpine container.
# It never touches the production volume: the base backup is unpacked into an empty --data directory, the WAL archive
# is mounted read-only, and the container replays up to the target and promotes.
#
#   scripts/restore-pitr.sh --base <dir|base.tar.gz> --wal <wal-dir> (--target-time <ISO-8601> | --latest) \
#       --data <empty-dir> --port <port> [--user <superuser>] [--image postgres:16-alpine] [--name <container>] \
#       [--timeout <seconds>] [--dry-run]
#
# --base   directory produced by pg_basebackup (contains base.tar.gz) or the base.tar.gz itself
# --wal    directory with the archived segments (the cvg-wal-archive volume or its off-site copy)
# --data   empty (or missing) directory that receives the restored cluster; a non-empty one is refused
# --user   superuser of the cluster (POSTGRES_USER of the stack); default $POSTGRES_USER or postgres
# Prints elapsed seconds and the last replayed LSN/timestamp as JSON. The container stays up on 127.0.0.1:<port>
# for inspection; remove it with `docker rm -f <name>` (printed).
set -euo pipefail

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
fail() { printf 'Erro: %s\n' "$1" >&2; exit 2; }

base="" wal="" target="" latest="false" data="" port="" dry_run="false"
image="postgres:16-alpine" name="" timeout="1800" pguser="${POSTGRES_USER:-postgres}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --base) base="${2:?--base exige um valor}"; shift 2 ;;
    --wal) wal="${2:?--wal exige um valor}"; shift 2 ;;
    --target-time) target="${2:?--target-time exige um valor}"; shift 2 ;;
    --latest) latest="true"; shift ;;
    --data) data="${2:?--data exige um valor}"; shift 2 ;;
    --port) port="${2:?--port exige um valor}"; shift 2 ;;
    --user) pguser="${2:?--user exige um valor}"; shift 2 ;;
    --image) image="${2:?--image exige um valor}"; shift 2 ;;
    --name) name="${2:?--name exige um valor}"; shift 2 ;;
    --timeout) timeout="${2:?--timeout exige um valor}"; shift 2 ;;
    --dry-run) dry_run="true"; shift ;;
    *) fail "argumento desconhecido: $1 (use --help)" ;;
  esac
done

[[ -n "$base" ]] || fail "--base é obrigatório"
[[ -n "$wal" ]] || fail "--wal é obrigatório"
[[ -n "$data" ]] || fail "--data é obrigatório"
[[ -n "$port" ]] || fail "--port é obrigatório"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || fail "--port deve estar entre 1024 e 65535"
[[ "$timeout" =~ ^[0-9]+$ ]] || fail "--timeout deve ser um número de segundos"
[[ "$pguser" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "--user inválido"
if [[ -n "$target" && "$latest" == "true" ]]; then fail "use --target-time OU --latest, não os dois"; fi
if [[ -z "$target" && "$latest" != "true" ]]; then fail "informe --target-time <ISO-8601> ou --latest"; fi
if [[ -n "$target" ]]; then
  [[ "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[T\ ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$ ]] \
    || fail "--target-time deve ser ISO-8601 com fuso, ex.: 2026-10-08T14:30:00Z"
fi
[[ -d "$wal" ]] || fail "diretório de WAL não encontrado: $wal"

if [[ -d "$base" ]]; then base_file="$base/base.tar.gz"; else base_file="$base"; fi
[[ -f "$base_file" ]] || fail "backup base não encontrado: $base_file"
[[ "$base_file" == *.tar.gz || "$base_file" == *.tgz ]] || fail "o backup base deve ser um .tar.gz (pg_basebackup --format=tar --gzip)"

if [[ -e "$data" ]]; then
  [[ -d "$data" ]] || fail "--data existe e não é um diretório: $data"
  [[ -z "$(ls -A "$data")" ]] || fail "--data não está vazio ($data); recusando restaurar sobre dados existentes"
fi
name="${name:-cvg-pitr-restore-$$}"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "--name inválido"

if [[ "$latest" == "true" ]]; then target_desc="latest"; else target_desc="$target"; fi
if [[ "$dry_run" == "true" ]]; then
  printf '{"event":"pitr.dry_run","base":"%s","wal":"%s","data":"%s","port":%s,"target":"%s","image":"%s","container":"%s"}\n' \
    "$base_file" "$wal" "$data" "$port" "$target_desc" "$image" "$name"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker não encontrado"
mkdir -p "$data"
data="$(cd "$data" && pwd)"; wal="$(cd "$wal" && pwd)"; base_file="$(cd "$(dirname "$base_file")" && pwd)/$(basename "$base_file")"

start_epoch="$(date +%s)"
# Recovery settings go into postgresql.auto.conf; recovery.signal switches the server into archive recovery.
# restore_command never overwrites and fails cleanly (non-zero) at the end of the archive, which ends recovery.
recovery_conf="restore_command = 'cp /wal-archive/%f \"%p\"'"$'\n'"recovery_target_timeline = 'latest'"$'\n'
if [[ "$latest" != "true" ]]; then
  # PostgreSQL's recovery_target_time parser rejects the ISO "T" separator and the "Z" suffix (verified on 16.15).
  pg_target="${target/T/ }"
  pg_target="${pg_target%Z}"; [[ "$pg_target" == "$target" || "$target" != *Z ]] || pg_target+="+00"
  recovery_conf+="recovery_target_time = '$pg_target'"$'\n'"recovery_target_action = 'promote'"$'\n'"recovery_target_inclusive = true"$'\n'
fi

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:$port:5432" \
  -v "$data:/pgdata" -v "$wal:/wal-archive:ro" -v "$base_file:/base/base.tar.gz:ro" \
  -e RECOVERY_CONF="$recovery_conf" --entrypoint sh "$image" -c '
    set -e
    tar -xzf /base/base.tar.gz -C /pgdata
    printf "%s" "$RECOVERY_CONF" >> /pgdata/postgresql.auto.conf
    touch /pgdata/recovery.signal
    chown -R postgres:postgres /pgdata
    chmod 700 /pgdata
    exec su-exec postgres postgres -D /pgdata -c archive_mode=off
  ' >/dev/null

psql_value() { docker exec "$name" psql -U "$pguser" -d postgres -Atqc "$1" 2>/dev/null; }

deadline=$(( start_epoch + timeout ))
promoted="false"
while (( $(date +%s) < deadline )); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != "true" ]]; then
    docker logs "$name" 2>&1 | tail -30 >&2
    docker rm -f "$name" >/dev/null 2>&1 || true
    fail "o PostgreSQL de restore terminou antes de promover (veja o log acima)"
  fi
  if [[ "$(psql_value 'SELECT pg_is_in_recovery()' || true)" == "f" ]]; then promoted="true"; break; fi
  sleep 1
done
if [[ "$promoted" != "true" ]]; then
  docker logs "$name" 2>&1 | tail -30 >&2
  fail "tempo esgotado (${timeout}s) sem promoção; o container $name segue de pé para inspeção"
fi

elapsed=$(( $(date +%s) - start_epoch ))
last_lsn="$(psql_value 'SELECT pg_last_wal_replay_lsn()' || true)"
last_ts="$(psql_value "SELECT to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')" || true)"
printf '{"event":"pitr.restored","elapsedSeconds":%s,"target":"%s","lastReplayedLsn":"%s","lastReplayedTimestamp":"%s","container":"%s","port":%s,"dataDirectory":"%s"}\n' \
  "$elapsed" "$target_desc" "$last_lsn" "$last_ts" "$name" "$port" "$data"
printf 'Restaurado em %s s. Inspecione com: docker exec %s psql -U %s -d <banco>. Remova com: docker rm -f %s\n' "$elapsed" "$name" "$pguser" "$name" >&2
