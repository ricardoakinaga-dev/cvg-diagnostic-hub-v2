#!/usr/bin/env bash
# Generates, OUTSIDE git, what the on-prem overlay (docker-compose.onprem.yml, PROD-307/PROD-308) needs:
#   <dir>/certs/ca.crt, ca.key        internal CA (EC P-256, 10 years) trusted by app, worker, migrate and bootstrap
#   <dir>/certs/scanner.crt, .key     certificate of the scanner adapter (SAN DNS:scanner, 825 days; renew with --renew-scanner)
#   <dir>/minio-kms.key               MinIO encryption-at-rest key: "<name>:<base64 of 32 random bytes>"
#
#   bash scripts/onprem-init.sh [dir] [--renew-scanner] [--force]      default dir: .data/onprem (gitignored)
#
# Never overwrites the CA or the KMS key unless --force: a new KMS key makes every existing attachment unreadable, so
# the only legitimate way to replace it is a documented migration with a restore rehearsal (BACKUP_RESTORE.md).
# Keep a copy of minio-kms.key and ca.key in the secret store, with the database passwords; chmod 600 on the host.
set -euo pipefail

DIR="${1:-.data/onprem}"
RENEW_SCANNER="false"
FORCE="false"
for arg in "${@:2}"; do
  case "$arg" in
    --renew-scanner) RENEW_SCANNER="true" ;;
    --force) FORCE="true" ;;
    --help|-h) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done
case "$DIR" in --help|-h) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
command -v openssl >/dev/null 2>&1 || { echo "openssl é obrigatório" >&2; exit 2; }
KEY_NAME="${ONPREM_KMS_KEY_NAME:-cvg-attachments}"
[[ "$KEY_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "ONPREM_KMS_KEY_NAME inválido (a-z, 0-9, hífen)" >&2; exit 2; }

umask 077
mkdir -p "$DIR/certs"
CERTS="$DIR/certs"
created=()

if [[ -f "$CERTS/ca.key" && "$FORCE" != "true" ]]; then
  echo "{\"event\":\"onprem.ca_kept\",\"path\":\"$CERTS/ca.crt\"}" >&2
else
  openssl ecparam -name prime256v1 -genkey -noout -out "$CERTS/ca.key"
  openssl req -x509 -new -key "$CERTS/ca.key" -sha256 -days 3650 -subj "/CN=CVG Diagnostic Hub on-prem CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$CERTS/ca.crt"
  created+=("$CERTS/ca.crt")
  RENEW_SCANNER="true"
fi

if [[ -f "$CERTS/scanner.crt" && "$RENEW_SCANNER" != "true" && "$FORCE" != "true" ]]; then
  echo "{\"event\":\"onprem.scanner_cert_kept\",\"path\":\"$CERTS/scanner.crt\"}" >&2
else
  openssl ecparam -name prime256v1 -genkey -noout -out "$CERTS/scanner.key"
  openssl req -new -key "$CERTS/scanner.key" -subj "/CN=scanner" -out "$CERTS/scanner.csr"
  ext_file="$(mktemp)"
  printf 'subjectAltName=DNS:scanner,DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$ext_file"
  openssl x509 -req -in "$CERTS/scanner.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" -CAcreateserial -days 825 -sha256 \
    -extfile "$ext_file" -out "$CERTS/scanner.crt" 2>/dev/null
  rm -f "$ext_file" "$CERTS/scanner.csr" "$CERTS/ca.srl"
  created+=("$CERTS/scanner.crt")
fi

if [[ -f "$DIR/minio-kms.key" && "$FORCE" != "true" ]]; then
  echo "{\"event\":\"onprem.kms_key_kept\",\"path\":\"$DIR/minio-kms.key\"}" >&2
else
  printf '%s:%s\n' "$KEY_NAME" "$(openssl rand -base64 32)" > "$DIR/minio-kms.key"
  created+=("$DIR/minio-kms.key")
fi

chmod 600 "$CERTS"/*.key "$DIR/minio-kms.key"
chmod 644 "$CERTS"/*.crt
ca_expires="$(openssl x509 -in "$CERTS/ca.crt" -noout -enddate | cut -d= -f2)"
scanner_expires="$(openssl x509 -in "$CERTS/scanner.crt" -noout -enddate | cut -d= -f2)"
openssl verify -CAfile "$CERTS/ca.crt" "$CERTS/scanner.crt" >/dev/null
printf '{"event":"onprem.initialized","dir":"%s","created":%s,"caExpires":"%s","scannerCertExpires":"%s","kmsKeyName":"%s"}\n' \
  "$DIR" "$(printf '%s\n' "${created[@]:-}" | sed '/^$/d' | awk 'BEGIN{printf "["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}')" \
  "$ca_expires" "$scanner_expires" "$KEY_NAME"
