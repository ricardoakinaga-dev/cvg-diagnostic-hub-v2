#!/bin/sh
# D-051: proves, against the live MinIO, that the least-privilege users behave as documented. Run by the drills and by
# the operator after a change to deploy/minio/iam.sh:
#   docker compose ... run --rm --entrypoint sh storage-iam /usr/local/bin/cvg-storage-iam-verify
# Same variables as cvg-storage-iam (root, app and offsite users; *_FILE accepted). Writes and removes probe objects
# under .cvg-iam-verify/ with the app user; never touches other objects. Exit 1 on the first expectation that fails.
set -eu
umask 077

secret() {
  name="$1"
  file="$(eval "printf '%s' \"\${${name}_FILE:-}\"")"
  value="$(eval "printf '%s' \"\${${name}:-}\"")"
  if [ -n "$file" ]; then value="$(cat "$file")"; fi
  printf '%s' "$value"
}
ENDPOINT="${STORAGE_ENDPOINT:?}"
BUCKET="${STORAGE_BUCKET:?}"
HOST="${ENDPOINT#http://}"; HOST="${HOST#https://}"
SCHEME="http"; case "$ENDPOINT" in https://*) SCHEME="https" ;; esac
export MC_CONFIG_DIR="${TMPDIR:-/tmp}/mc-verify"
export MC_HOST_root="$SCHEME://$(secret STORAGE_ROOT_USER):$(secret STORAGE_ROOT_PASSWORD)@$HOST"
export MC_HOST_app="$SCHEME://${STORAGE_ACCESS_KEY:?}:$(secret STORAGE_SECRET_KEY)@$HOST"
OFFSITE_USER="${OFFSITE_STORAGE_ACCESS_KEY:-}"
[ -z "$OFFSITE_USER" ] || export MC_HOST_off="$SCHEME://$OFFSITE_USER:$(secret OFFSITE_STORAGE_SECRET_KEY)@$HOST"

failures=0
expect_ok() { # description, command...
  description="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "{\"check\":\"$description\",\"result\":\"ok\"}"; else echo "{\"check\":\"$description\",\"result\":\"FAIL\"}" >&2; failures=$((failures + 1)); fi
}
expect_denied() { # description, command...
  description="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "{\"check\":\"$description\",\"result\":\"FAIL (allowed)\"}" >&2; failures=$((failures + 1)); else echo "{\"check\":\"$description\",\"result\":\"denied\"}"; fi
}

probe="$BUCKET/.cvg-iam-verify/probe-$$"
printf 'v1' > "$MC_CONFIG_DIR.v1" 2>/dev/null || { mkdir -p "$MC_CONFIG_DIR"; printf 'v1' > "$MC_CONFIG_DIR.v1"; }
printf 'v2' > "$MC_CONFIG_DIR.v2"

expect_ok "app puts an object" mc --quiet cp "$MC_CONFIG_DIR.v1" "app/$probe"
expect_ok "app overwrites it (new version)" mc --quiet cp "$MC_CONFIG_DIR.v2" "app/$probe"
expect_ok "app reads it" mc --quiet cat "app/$probe"
expect_ok "app lists the bucket" mc --quiet ls "app/$BUCKET/"
expect_denied "app suspends versioning" mc --quiet version suspend "app/$BUCKET"
expect_denied "app sets an anonymous policy" mc --quiet anonymous set download "app/$BUCKET"
expect_denied "app reads the bucket policy" mc --quiet anonymous get "app/$BUCKET"
expect_denied "app clears the default encryption" mc --quiet encrypt clear "app/$BUCKET"
expect_denied "app removes the lifecycle" mc --quiet ilm rule rm --all --force "app/$BUCKET"
first_version="$(mc ls --versions --json "root/$probe" | tr ',' '\n' | grep '"versionId"' | tail -1 | sed 's/.*"versionId":"\([^"]*\)".*/\1/')"
expect_denied "app deletes a specific version" mc --quiet rm --version-id "$first_version" "app/$probe"
expect_denied "app purges every version" mc --quiet rm --versions --force "app/$probe"
expect_ok "app deletes the current object (delete marker only)" mc --quiet rm "app/$probe"
expect_ok "root still reads the previous version" mc --quiet cat --version-id "$first_version" "root/$probe"
if [ -n "$OFFSITE_USER" ]; then
  expect_ok "offsite reads the previous version" mc --quiet cat --version-id "$first_version" "off/$probe"
  expect_ok "offsite lists the bucket" mc --quiet ls "off/$BUCKET/"
  expect_denied "offsite writes an object" mc --quiet cp "$MC_CONFIG_DIR.v1" "off/$BUCKET/.cvg-iam-verify/offsite-$$"
  expect_denied "offsite deletes an object" mc --quiet rm --version-id "$first_version" "off/$probe"
fi
# Clean the probe versions with the root user (the only one allowed to).
mc --quiet rm --versions --force "root/$probe" >/dev/null 2>&1 || true
rm -f "$MC_CONFIG_DIR.v1" "$MC_CONFIG_DIR.v2"

if [ "$failures" -gt 0 ]; then
  echo "{\"event\":\"storage_iam.verification_failed\",\"failures\":$failures}" >&2
  exit 1
fi
echo "{\"event\":\"storage_iam.verified\",\"bucket\":\"$BUCKET\",\"users\":[\"${STORAGE_ACCESS_KEY}\"${OFFSITE_USER:+,\"$OFFSITE_USER\"}]}"
