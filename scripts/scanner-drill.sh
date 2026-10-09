#!/usr/bin/env bash
# Rehearsal of the on-prem antivirus (PROD-308) on a DISPOSABLE Compose project: starts clamav + scanner from the
# on-prem overlay with a throwaway CA, waits for the daemon and the adapter, then sends through the app's scan contract
#   (a) a clean file            -> CLEAN
#   (b) the EICAR test file     -> QUARANTINED (the verdict comes from clamd, not from a string match)
#   (c) a MIME divergence       -> QUARANTINED
#   (d) a wrong API key         -> 401
# and prints a JSON summary with the ClamAV version and signature database date. Tears everything down.
#
#   npm run scanner:drill            # or: bash scripts/scanner-drill.sh [--keep]
#
# Environment: DRILL_PROJECT (default cvg-scanner-drill), DRILL_SCANNER_PORT (loopback port, default 59443).
# ClamAV needs up to a few minutes on first start (signature database load); the image ships the database, freshclam
# then refreshes it when egress to database.clamav.net exists. Never point it at a production Compose project.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${DRILL_PROJECT:-cvg-scanner-drill}"
SCANNER_PORT="${DRILL_SCANNER_PORT:-59443}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT inválido" >&2; exit 2; }
[[ "$PROJECT" != "cvg-hub" && "$PROJECT" != "cvg-diagnostic-hub-v2" && "$PROJECT" != "cvg-diagnostic-local" ]] || { echo "recusando usar o projeto $PROJECT: use um projeto descartável" >&2; exit 2; }
[[ "$SCANNER_PORT" =~ ^[0-9]+$ ]] || { echo "DRILL_SCANNER_PORT deve ser inteiro" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl é obrigatório" >&2; exit 2; }

work_dir="$(mktemp -d)"
env_file="$work_dir/drill.env"
onprem_dir="$work_dir/onprem"
secrets_dir="$work_dir/secrets"
DC=(docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" -f "$ROOT_DIR/docker-compose.secrets.yml" -f "$ROOT_DIR/docker-compose.storage-drill.yml" --env-file "$env_file")
drill_started="$(date +%s)"

cleanup() {
  status=$?
  if [[ "$KEEP" != "true" ]]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  else
    echo "--keep: projeto $PROJECT e $work_dir mantidos" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

secret() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
step() { printf '[%ss] %s\n' "$(( $(date +%s) - drill_started ))" "$1" >&2; }
wait_for() { # description, timeout, command...
  local description="$1" limit="$2"; shift 2
  local until=$(( $(date +%s) + limit ))
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) < until )) || { echo "tempo esgotado esperando: $description" >&2; "${DC[@]}" logs --tail 40 clamav scanner >&2 || true; exit 1; }
    sleep 3
  done
}

bash "$ROOT_DIR/scripts/onprem-init.sh" "$onprem_dir" >/dev/null 2>&1
bash "$ROOT_DIR/scripts/secrets-init.sh" "$secrets_dir" >/dev/null
api_key="$(cat "$secrets_dir/malware_scanner_api_key")"
sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=localhost|" \
    -e "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=${DRILL_IMAGE_PREFIX:-$PROJECT}|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://storage:9000|" \
    -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=drill-attachments|" \
    -e "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=cvg-app|" \
    -e "s|^MALWARE_SCANNER_ENDPOINT=.*|MALWARE_SCANNER_ENDPOINT=https://scanner:9443/scan|" \
    -e "s|^MALWARE_SCANNER_ALLOWED_HOSTS=.*|MALWARE_SCANNER_ALLOWED_HOSTS=scanner|" \
    -e "s|^ONPREM_DIR=.*|ONPREM_DIR=$onprem_dir|" \
    -e "s|^SECRETS_DIR=.*|SECRETS_DIR=$secrets_dir|" \
    "$ROOT_DIR/.env.production.example" > "$env_file"
printf 'DRILL_SCANNER_PORT=%s\n' "$SCANNER_PORT" >> "$env_file"
chmod 600 "$env_file"

step "subindo clamav e scanner (projeto $PROJECT)"
"${DC[@]}" up -d clamav scanner >&2
healthy() { [[ "$(docker inspect -f '{{.State.Health.Status}}' "$("${DC[@]}" ps -q "$1")" 2>/dev/null)" == "healthy" ]]; }
wait_for "clamd pronto" 600 healthy clamav
wait_for "scanner pronto" 120 healthy scanner
clamav_container="$("${DC[@]}" ps -q clamav)"
clamav_version="$(docker exec "$clamav_container" clamdscan --version 2>/dev/null | tr -d '\n' || echo unknown)"
step "antivírus pronto: $clamav_version"

ca="$onprem_dir/certs/ca.crt"
endpoint="https://localhost:${SCANNER_PORT}/scan"
scan() { # file, declared mime, detected mime, api key -> "<status> <json>"
  local file="$1" declared="$2" detected="$3" key="$4" checksum
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"
  curl -s --cacert "$ca" -o "$work_dir/response.json" -w '%{http_code}' -X POST "$endpoint" \
    -H "authorization: Bearer $key" -H "content-type: $declared" -H "x-declared-mime: $declared" -H "x-detected-mime: $detected" \
    -H "x-content-sha256: $checksum" --data-binary "@$file"
  printf ' %s\n' "$(cat "$work_dir/response.json")"
}
verdict() { sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p' <<<"$1"; }

printf '%%PDF-1.4\n%% clean synthetic report for the antivirus rehearsal\n' > "$work_dir/clean.pdf"
# Built at runtime so that this script is not itself a signature.
printf '%s%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE' '!$H+H*' > "$work_dir/eicar.com"

clean_result="$(scan "$work_dir/clean.pdf" application/pdf application/pdf "$api_key")"
[[ "$(verdict "$clean_result")" == "CLEAN" ]] || { echo "arquivo limpo não foi CLEAN: $clean_result" >&2; exit 1; }
eicar_result="$(scan "$work_dir/eicar.com" application/pdf application/pdf "$api_key")"
[[ "$(verdict "$eicar_result")" == "QUARANTINED" ]] || { echo "EICAR não foi QUARANTINED: $eicar_result" >&2; exit 1; }
mime_result="$(scan "$work_dir/clean.pdf" application/pdf image/png "$api_key")"
[[ "$(verdict "$mime_result")" == "QUARANTINED" ]] || { echo "divergência de MIME não foi QUARANTINED: $mime_result" >&2; exit 1; }
wrong_key="$(scan "$work_dir/clean.pdf" application/pdf application/pdf "${api_key:0:-1}0" | cut -d' ' -f1)"
[[ "$wrong_key" == "401" ]] || { echo "chave errada respondeu $wrong_key, esperado 401" >&2; exit 1; }
signature_date="$(docker exec "$clamav_container" sh -c 'sigtool --info /var/lib/clamav/daily.cld 2>/dev/null || sigtool --info /var/lib/clamav/daily.cvd 2>/dev/null' | sed -n 's/^Build time: //p' | head -1 || true)"
step "EICAR em quarentena, limpo aceito, MIME divergente em quarentena, chave errada recusada"

printf '{"event":"scanner_drill.completed","project":"%s","clamav":"%s","signatureBuildTime":"%s","clean":"%s","eicar":"%s","mimeMismatch":"%s","wrongKeyStatus":%s,"totalSeconds":%s}\n' \
  "$PROJECT" "$clamav_version" "${signature_date:-unknown}" "$(verdict "$clean_result")" "$(verdict "$eicar_result")" "$(verdict "$mime_result")" "$wrong_key" "$(( $(date +%s) - drill_started ))"
