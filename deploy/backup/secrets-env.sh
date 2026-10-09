#!/bin/sh
# Sourced by the backup, offsite and restore scripts (PROD-302, D-051). POSIX sh, no bashisms.
#
#   load_file_secrets NAME...   for each NAME: when NAME_FILE is set, read the file (trailing newline trimmed) into
#                               NAME; NAME and NAME_FILE set with different values is refused; an unreadable file is
#                               refused; an empty file means unset. Same rules as src/server/security/file-secrets.ts.
#   configure_offsite_crypt     defines the rclone remote `offsitecrypt` (type crypt over OFFSITE_CRYPT_REMOTE) from
#                               OFFSITE_CRYPT_PASSWORD_FILE and OFFSITE_CRYPT_SALT_FILE, with the passphrases obscured
#                               the way rclone expects. Prints nothing; the secrets never reach the command line.
#   remote_type NAME            prints the rclone type of a named remote (crypt, s3, sftp, local...) or "unknown".

load_file_secrets() {
  for _name in "$@"; do
    _file="$(eval "printf '%s' \"\${${_name}_FILE:-}\"")"
    [ -n "$_file" ] || continue
    if [ ! -r "$_file" ]; then
      echo "{\"event\":\"secrets.refused\",\"reason\":\"SECRET_FILE_UNREADABLE:$_name\"}" >&2
      return 1
    fi
    # Command substitution drops the trailing newline(s) an editor leaves; nothing else is touched.
    _value="$(cat "$_file")"
    _current="$(eval "printf '%s' \"\${${_name}:-}\"")"
    if [ -n "$_current" ] && [ "$_current" != "$_value" ]; then
      echo "{\"event\":\"secrets.refused\",\"reason\":\"SECRET_CONFLICT:$_name\"}" >&2
      return 1
    fi
    if [ -z "$_value" ]; then unset "$_name"; else eval "$_name=\"\$_value\""; export "$_name"; fi
  done
}

remote_type() {
  rclone listremotes --long 2>/dev/null | awk -v name="$1:" '$1 == name { print $2; found = 1 } END { if (!found) print "unknown" }'
}

configure_offsite_crypt() {
  [ -n "${OFFSITE_CRYPT_PASSWORD_FILE:-}" ] || return 0
  load_file_secrets OFFSITE_CRYPT_PASSWORD OFFSITE_CRYPT_SALT || return 1
  [ -n "${OFFSITE_CRYPT_PASSWORD:-}" ] || { echo '{"event":"secrets.refused","reason":"OFFSITE_CRYPT_PASSWORD empty"}' >&2; return 1; }
  [ -n "${OFFSITE_CRYPT_REMOTE:-}" ] || { echo '{"event":"secrets.refused","reason":"OFFSITE_CRYPT_REMOTE missing (the remote the crypt wraps)"}' >&2; return 1; }
  RCLONE_CONFIG_OFFSITECRYPT_TYPE=crypt
  RCLONE_CONFIG_OFFSITECRYPT_REMOTE="$OFFSITE_CRYPT_REMOTE"
  RCLONE_CONFIG_OFFSITECRYPT_FILENAME_ENCRYPTION=standard
  RCLONE_CONFIG_OFFSITECRYPT_DIRECTORY_NAME_ENCRYPTION=true
  RCLONE_CONFIG_OFFSITECRYPT_PASSWORD="$(printf '%s' "$OFFSITE_CRYPT_PASSWORD" | rclone obscure -)"
  export RCLONE_CONFIG_OFFSITECRYPT_TYPE RCLONE_CONFIG_OFFSITECRYPT_REMOTE RCLONE_CONFIG_OFFSITECRYPT_FILENAME_ENCRYPTION RCLONE_CONFIG_OFFSITECRYPT_DIRECTORY_NAME_ENCRYPTION RCLONE_CONFIG_OFFSITECRYPT_PASSWORD
  if [ -n "${OFFSITE_CRYPT_SALT:-}" ]; then
    RCLONE_CONFIG_OFFSITECRYPT_PASSWORD2="$(printf '%s' "$OFFSITE_CRYPT_SALT" | rclone obscure -)"
    export RCLONE_CONFIG_OFFSITECRYPT_PASSWORD2
  fi
  unset OFFSITE_CRYPT_PASSWORD OFFSITE_CRYPT_SALT
}
