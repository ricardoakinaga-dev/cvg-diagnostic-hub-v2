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
  if [[ "$ENGINE" == "rg" ]]; then
    rg --files --hidden \
      -g '.env' -g '.env.*' \
      -g '!node_modules/**' -g '!.git/**' -g '!.env.example' -g '!.env.production.example' 2>/dev/null || true
  else
    find . -path ./node_modules -prune -o -path ./.git -prune -o \
      -type f \( -name '.env' -o -name '.env.*' \) -print 2>/dev/null | sed 's|^\./||'
  fi
}

env_failure() {
  printf 'Secret scan falhou: arquivo de ambiente local não deve ser versionado: %s\n' "$1" >&2
  exit 1
}

while IFS= read -r env_file; do
  [[ -z "$env_file" || "$env_file" == ".env.example" || "$env_file" == ".env.production.example" ]] && continue
  [[ -f "$env_file" ]] || continue
  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Secret scan ERRO: git indisponível — não é possível determinar se %s é versionável.\n' "$env_file" >&2
    exit 2
  fi
  if git ls-files --error-unmatch -- "$env_file" >/dev/null 2>&1; then
    env_failure "$env_file"
  fi
  if ! git check-ignore -q -- "$env_file"; then
    env_failure "$env_file"
  fi
done < <(list_env_candidates)

echo "Secret scan passou (motor: ${REPORT_ENGINE}): nenhum padrão de segredo versionável encontrado."
