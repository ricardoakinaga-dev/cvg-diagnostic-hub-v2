#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# AUD-001: o scan NUNCA pode aprovar silenciosamente.
# Motor: `rg` quando existe; senão fallback explícito `grep -rInE` com exclusões
# equivalentes. Sem nenhum dos dois o script aborta com exit != 0.
ENGINE=""
REPORT_ENGINE=""
if command -v rg >/dev/null 2>&1; then
  ENGINE="rg"
  REPORT_ENGINE="rg (PCRE)"
elif command -v grep >/dev/null 2>&1; then
  ENGINE="grep"
  REPORT_ENGINE="grep -rInE (fallback; rg ausente)"
else
  printf 'Secret scan ABORTADO: nenhum motor de busca disponível (rg e grep ausentes).\n' >&2
  printf 'Não foi possível varrer a árvore — recusando aprovação.\n' >&2
  exit 2
fi

# Padrões equivalentes nos dois motores (PCRE para rg, ERE para grep).
PATTERN_PCRE='BEGIN (?:RSA|EC|OPENSSH|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,}|AWS_SECRET_ACCESS_KEY[[:space:]]*='
PATTERN_ERE='BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,}|AWS_SECRET_ACCESS_KEY[[:space:]]*='

echo "Secret scan iniciado (motor: ${REPORT_ENGINE})."

# rc: 0 = achado, 1 = nenhum achado, >=2 = erro do motor (varredura incompleta).
scan_secrets() {
  if [[ "$ENGINE" == "rg" ]]; then
    rg --hidden --no-heading --line-number \
      --glob '!node_modules/**' \
      --glob '!.git/**' \
      --glob '!coverage/**' \
      --glob '!playwright-report/**' \
      --glob '!test-results/**' \
      --glob '!.data/**' \
      --glob '!.next*/**' \
      --glob '!docs/**' \
      --glob '!package-lock.json' \
      --glob '!*.log' \
      --glob '!*.tsbuildinfo' \
      --glob '!next-env.d.ts' \
      --glob '!.env' \
      --glob '!.env.*' \
      --glob '!deploy/backup/rclone.conf' \
      --glob '!.writer.lock' \
      -P "$PATTERN_PCRE" .
  else
    grep -rInE \
      --exclude-dir=node_modules \
      --exclude-dir=.git \
      --exclude-dir=coverage \
      --exclude-dir=playwright-report \
      --exclude-dir=test-results \
      --exclude-dir=.data \
      --exclude-dir='.next*' \
      --exclude-dir=docs \
      --exclude=package-lock.json \
      --exclude='*.log' \
      --exclude='*.tsbuildinfo' \
      --exclude=next-env.d.ts \
      --exclude='.env' \
      --exclude='.env.*' \
      --exclude='rclone.conf' \
      --exclude='.writer.lock' \
      -- "$PATTERN_ERE" .
  fi
}

scan_rc=0
scan_secrets || scan_rc=$?

case "$scan_rc" in
  0)
    printf 'Secret scan falhou: padrão de segredo encontrado (motor: %s).\n' "$REPORT_ENGINE" >&2
    exit 1
    ;;
  1) ;;
  *)
    printf 'Secret scan ERRO: motor=%s rc=%d — varredura incompleta, recusando aprovação.\n' "$REPORT_ENGINE" "$scan_rc" >&2
    exit 2
    ;;
esac

# Arquivos .env locais não podem ser versionáveis (nem versionados, nem sem ignore).
list_env_candidates() {
  # rg respects ignored parent directories even when an .env file was forced
  # into the index. Include the Git inventory before traversing local files.
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z --cached -- ':(glob)**/.env' ':(glob)**/.env.*'
  fi
  if [[ "$ENGINE" == "rg" ]]; then
    rg --files --hidden --null \
      -g '.env' -g '.env.*' \
      -g '!node_modules/**' -g '!.git/**' 2>/dev/null || true
  else
    find . -path ./node_modules -prune -o -path ./.git -prune -o \
      -type f \( -name '.env' -o -name '.env.*' \) -print0 2>/dev/null
  fi
}

env_failure() {
  printf 'Secret scan falhou: arquivo de ambiente local não deve ser versionado: %s\n' "$1" >&2
  exit 1
}

while IFS= read -r -d '' env_file; do
  env_file="${env_file#./}"
  [[ -z "$env_file" || "$env_file" == ".env.example" || "$env_file" == ".env.production.example" || "$env_file" == ".env.monitoring.example" ]] && continue
  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Secret scan ERRO: git indisponível — não é possível determinar se %s é versionável.\n' "$env_file" >&2
    exit 2
  fi
  if git ls-files --error-unmatch -- "$env_file" >/dev/null 2>&1; then
    env_failure "$env_file"
  fi
  [[ -f "$env_file" ]] || continue
  if ! git check-ignore -q -- "$env_file"; then
    env_failure "$env_file"
  fi
done < <(list_env_candidates)

# PROD-304: o rclone.conf real guarda as credenciais da cópia externa; só o .example pode ser versionado.
if [[ -f deploy/backup/rclone.conf ]]; then
  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Secret scan ERRO: git indisponível — não é possível determinar se deploy/backup/rclone.conf é versionável.\n' >&2
    exit 2
  fi
  if git ls-files --error-unmatch -- deploy/backup/rclone.conf >/dev/null 2>&1 || ! git check-ignore -q -- deploy/backup/rclone.conf; then
    env_failure "deploy/backup/rclone.conf"
  fi
fi

echo "Secret scan passou (motor: ${REPORT_ENGINE}): nenhum padrão de segredo versionável encontrado."
