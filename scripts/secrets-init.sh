#!/usr/bin/env bash
# PROD-302 / D-051: creates the secret files of ONE environment (homologation or production), outside git, for
# docker-compose.secrets.yml and docker-compose.onprem.yml. One file per secret, random content, mode 600, directory 700.
#
#   bash scripts/secrets-init.sh <dir> [--rotate NAME ...] [--owner UID:GID] [--allow-empty NAME ...]
#
#   <dir>                e.g. /etc/cvg-hub/prod/secrets (SECRETS_DIR in the env file); created if missing
#   --rotate NAME        regenerate that file (others untouched); run `up -d` afterwards (DEPLOYMENT section 13)
#   --owner UID:GID      chown the files to the uid/gid of the containers that read them (default: current user)
#   --allow-empty NAME   write an EMPTY file for an optional secret (postgres_backup_password = no PITR,
#                        metrics_scrape_token = metrics only for an ADMIN session); default is a random value
#
# Never overwrites an existing file without --rotate. Prints names only, never values. Keep a copy in the hospital's
# vault: minio-kms.key (onprem-init.sh) and these files are the keys to every attachment and to the database.
set -euo pipefail

DIR="${1:-}"
[[ -n "$DIR" && "$DIR" != "--help" && "$DIR" != "-h" ]] || { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "$([[ -n "$DIR" ]] && echo 0 || echo 2)"; }
shift
rotate=()
allow_empty=()
owner=""
while (($# > 0)); do
  case "$1" in
    --rotate) rotate+=("${2:?}"); shift 2 ;;
    --allow-empty) allow_empty+=("${2:?}"); shift 2 ;;
    --owner) owner="${2:?}"; shift 2 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
command -v openssl >/dev/null 2>&1 || { echo "openssl é obrigatório" >&2; exit 2; }

# name:kind. hex64 = 64 hex chars (32 bytes); pass = 40 chars [A-Za-z0-9] (safe in URLs and files);
# phrase = 48 chars (rclone crypt passphrase and salt).
SECRETS=(
  "postgres_password:pass"
  "postgres_migration_password:pass"
  "postgres_runtime_password:pass"
  "postgres_backup_password:pass"
  "session_secret:hex64"
  "trust_proxy_shared_secret:hex64"
  "metrics_scrape_token:hex64"
  "storage_root_password:pass"
  "storage_secret_key:pass"
  "offsite_storage_secret_key:pass"
  "malware_scanner_api_key:hex64"
  "offsite_crypt_password:phrase"
  "offsite_crypt_salt:phrase"
)

generate() {
  case "$1" in
    hex64) openssl rand -hex 32 ;;
    pass) openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; echo ;;
    phrase) openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 48; echo ;;
  esac
}
contains() { local needle="$1"; shift; for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done; return 1; }

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
created=()
rotated=()
kept=()
for entry in "${SECRETS[@]}"; do
  name="${entry%%:*}"; kind="${entry##*:}"
  target="$DIR/$name"
  if [[ -e "$target" ]] && ! contains "$name" "${rotate[@]:-}"; then kept+=("$name"); continue; fi
  if contains "$name" "${allow_empty[@]:-}"; then : > "$target.tmp"; else generate "$kind" > "$target.tmp"; fi
  chmod 600 "$target.tmp"
  mv -f "$target.tmp" "$target"
  if contains "$name" "${rotate[@]:-}"; then rotated+=("$name"); else created+=("$name"); fi
done
for name in "${rotate[@]:-}"; do
  [[ -z "$name" ]] || contains "$name" "${created[@]:-}" "${rotated[@]:-}" || { echo "--rotate $name: nome desconhecido" >&2; exit 2; }
done
if [[ -n "$owner" ]]; then chown "$owner" "$DIR"/* "$DIR"; fi

json_list() { local out=""; for item in "$@"; do [[ -z "$item" ]] && continue; out="${out:+$out,}\"$item\""; done; printf '[%s]' "$out"; }
# Distinctness: no two files with the same content (a copy-paste mistake would make one credential open two doors).
if (( $(cat "$DIR"/* 2>/dev/null | grep -v '^$' | sort | uniq -d | wc -l) > 0 )); then
  echo '{"event":"secrets.refused","reason":"two secret files have the same content"}' >&2; exit 1
fi
printf '{"event":"secrets.initialized","dir":"%s","created":%s,"rotated":%s,"kept":%s}\n' \
  "$DIR" "$(json_list "${created[@]:-}")" "$(json_list "${rotated[@]:-}")" "$(json_list "${kept[@]:-}")"
