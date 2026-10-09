#!/bin/sh
# PROD-302 / D-051: least privilege on the on-prem MinIO. Runs once per `up` (service storage-iam, image built from
# deploy/minio/Dockerfile.mc) with the ROOT credentials, which no other runtime service receives, and makes sure that:
#   - policy cvg-app        : s3:ListBucket on the bucket; s3:GetObject, s3:PutObject, s3:DeleteObject on its objects.
#                             No DeleteObjectVersion, no PutBucket*/PutLifecycle*/PutBucketPolicy/PutEncryption*, no
#                             BypassGovernance: an app that is taken over can only add delete markers, and every
#                             version stays recoverable for STORAGE_NONCURRENT_VERSION_DAYS.
#   - policy cvg-offsite    : s3:ListBucket + s3:GetObject only (the off-site copy reads, never writes nor deletes).
#   - user  STORAGE_ACCESS_KEY        (app, worker)  with cvg-app
#   - user  OFFSITE_STORAGE_ACCESS_KEY (offsite)     with cvg-offsite
# Idempotent: an existing user gets its secret re-set (rotation = change the secret and run `up` again) and the
# policies are re-created with the same content. Every *_SECRET accepts a *_FILE variant (Docker secret).
#
#   STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ROOT_USER[_FILE], STORAGE_ROOT_PASSWORD[_FILE],
#   STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY[_FILE], OFFSITE_STORAGE_ACCESS_KEY, OFFSITE_STORAGE_SECRET_KEY[_FILE]
set -eu
umask 077

# $1 variable name: when NAME_FILE is set the file content (trailing newline trimmed) wins; both set with different
# values is refused, like src/server/security/file-secrets.ts.
secret() {
  name="$1"
  file="$(eval "printf '%s' \"\${${name}_FILE:-}\"")"
  value="$(eval "printf '%s' \"\${${name}:-}\"")"
  if [ -n "$file" ]; then
    [ -r "$file" ] || { echo "{\"event\":\"storage_iam.refused\",\"reason\":\"SECRET_FILE_UNREADABLE:$name\"}" >&2; exit 1; }
    from_file="$(sed -e '$a\' "$file" | head -c 4096 | sed -e '$ s/\r\?$//')"
    from_file="$(printf '%s' "$from_file" | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n*$//')"
    if [ -n "$value" ] && [ "$value" != "$from_file" ]; then
      echo "{\"event\":\"storage_iam.refused\",\"reason\":\"SECRET_CONFLICT:$name\"}" >&2; exit 1
    fi
    value="$from_file"
  fi
  printf '%s' "$value"
}

ENDPOINT="${STORAGE_ENDPOINT:?STORAGE_ENDPOINT is required}"
BUCKET="${STORAGE_BUCKET:?STORAGE_BUCKET is required}"
ROOT_USER="$(secret STORAGE_ROOT_USER)"
ROOT_PASSWORD="$(secret STORAGE_ROOT_PASSWORD)"
APP_USER="${STORAGE_ACCESS_KEY:?STORAGE_ACCESS_KEY is required}"
APP_SECRET="$(secret STORAGE_SECRET_KEY)"
OFFSITE_USER="${OFFSITE_STORAGE_ACCESS_KEY:-}"
OFFSITE_SECRET="$(secret OFFSITE_STORAGE_SECRET_KEY)"
[ -n "$ROOT_USER" ] && [ -n "$ROOT_PASSWORD" ] || { echo '{"event":"storage_iam.refused","reason":"STORAGE_ROOT_USER/STORAGE_ROOT_PASSWORD missing"}' >&2; exit 1; }
[ -n "$APP_SECRET" ] || { echo '{"event":"storage_iam.refused","reason":"STORAGE_SECRET_KEY missing"}' >&2; exit 1; }
[ "$APP_USER" != "$ROOT_USER" ] || { echo '{"event":"storage_iam.refused","reason":"STORAGE_ACCESS_KEY must not be the root user (D-051)"}' >&2; exit 1; }
[ ${#APP_SECRET} -ge 16 ] || { echo '{"event":"storage_iam.refused","reason":"STORAGE_SECRET_KEY shorter than 16 characters"}' >&2; exit 1; }
if [ -n "$OFFSITE_USER" ]; then
  [ -n "$OFFSITE_SECRET" ] && [ ${#OFFSITE_SECRET} -ge 16 ] || { echo '{"event":"storage_iam.refused","reason":"OFFSITE_STORAGE_SECRET_KEY missing or shorter than 16 characters"}' >&2; exit 1; }
  [ "$OFFSITE_USER" != "$ROOT_USER" ] && [ "$OFFSITE_USER" != "$APP_USER" ] || { echo '{"event":"storage_iam.refused","reason":"OFFSITE_STORAGE_ACCESS_KEY must be its own user"}' >&2; exit 1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export MC_CONFIG_DIR="$work/mc"
# The root credential goes through the environment of mc (MC_HOST_root), never through argv. The secret of the user
# being created has to go in argv of `mc admin user add` (mc has no stdin form): it is visible in `ps` only inside this
# single-use container, which runs read-only, without capabilities and exits right after.
MC_HOST_root="$(printf 'http://%s:%s@%s' "$ROOT_USER" "$ROOT_PASSWORD" "${ENDPOINT#http://}")"
case "$ENDPOINT" in https://*) MC_HOST_root="$(printf 'https://%s:%s@%s' "$ROOT_USER" "$ROOT_PASSWORD" "${ENDPOINT#https://}")" ;; esac
export MC_HOST_root

# The explicit Deny matters: measured on MinIO 7aac2a2, an Allow of s3:DeleteObject alone still lets the caller delete a
# specific VERSION (`rm --version-id`, `rm --versions --force`); with the Deny only a delete marker can be created and the
# previous version stays readable with the root and the offsite users.
cat > "$work/cvg-app.json" <<EOF
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::$BUCKET"]},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$BUCKET/*"]},
  {"Effect":"Deny","Action":["s3:DeleteObjectVersion","s3:PutBucketVersioning","s3:PutLifecycleConfiguration","s3:PutBucketPolicy","s3:DeleteBucketPolicy","s3:PutEncryptionConfiguration","s3:BypassGovernanceRetention","s3:DeleteBucket","s3:PutBucketObjectLockConfiguration","s3:PutObjectRetention","s3:PutObjectLegalHold"],"Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"]}
]}
EOF
cat > "$work/cvg-offsite.json" <<EOF
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::$BUCKET"]},
  {"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::$BUCKET/*"]}
]}
EOF

mc --quiet admin policy create root cvg-app "$work/cvg-app.json" >/dev/null
mc --quiet admin policy create root cvg-offsite "$work/cvg-offsite.json" >/dev/null

ensure_user() { # name secret policy
  # Create or rotate: the secret follows what the environment (or the secret file) says now.
  mc --quiet admin user add root "$1" "$2" >/dev/null
  # `attach` fails when the policy is already attached; any other failure is caught by the check below, which reads
  # the user back and refuses to finish unless the policy is really attached.
  mc --quiet admin policy attach root "$3" --user "$1" >/dev/null 2>&1 || true
  attached="$(mc admin user info --json root "$1" 2>/dev/null | tr -d ' \n' | sed -n 's/.*"policyName":"\([^"]*\)".*/\1/p')"
  case ",$attached," in
    *",$3,"*) ;;
    *) echo "{\"event\":\"storage_iam.refused\",\"reason\":\"policy $3 not attached to user $1 (attached: ${attached:-none})\"}" >&2; exit 1 ;;
  esac
  mc --quiet admin user enable root "$1" >/dev/null
}
ensure_user "$APP_USER" "$APP_SECRET" cvg-app
users="\"$APP_USER\""
if [ -n "$OFFSITE_USER" ]; then
  ensure_user "$OFFSITE_USER" "$OFFSITE_SECRET" cvg-offsite
  users="$users,\"$OFFSITE_USER\""
fi
printf '{"event":"storage_iam.applied","bucket":"%s","users":[%s],"policies":["cvg-app","cvg-offsite"]}\n' "$BUCKET" "$users"
