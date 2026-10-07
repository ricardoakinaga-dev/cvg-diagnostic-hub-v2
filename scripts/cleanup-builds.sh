#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${ALLOW_CLEAN_BUILDS:-}" != "true" ]]; then
  printf 'cleanup-builds RECUSADO: diretórios de build não serão removidos.\n' >&2
  printf 'Exporte ALLOW_CLEAN_BUILDS=true para autorizar a limpeza.\n' >&2
  exit 2
fi

# Padrões autorizados (backlog AUD-004). O build ativo `.next/` NUNCA entra.
PATTERNS=(
  '.next-e2e-*'
  '.next-qa-*'
  '.next-visual-*'
  '.next-aaa3-*'
  '.next-postgres-*'
  '.next-quality-*'
)

shopt -s nullglob
candidates=()
for pattern in "${PATTERNS[@]}"; do
  for dir in $pattern; do
    [[ -d "$dir" ]] || continue
    if [[ "$dir" == ".next" ]]; then
      printf 'cleanup-builds ERRO: o build ativo .next/ está fora dos padrões autorizados.\n' >&2
      exit 1
    fi
    candidates+=("$dir")
  done
done
shopt -u nullglob

if ((${#candidates[@]} == 0)); then
  echo 'cleanup-builds: nenhum diretório de build obsoleto encontrado.'
else
  printf 'cleanup-builds: %d diretório(s) candidato(s): %s\n' "${#candidates[@]}" "${candidates[*]}"
fi

# Servidores ativos (next/playwright): diretórios em uso são preservados e reportados.
active_procs="$(pgrep -af 'next|playwright' 2>/dev/null | grep -v -e 'cleanup-builds' -e 'pgrep -af' || true)"
if [[ -n "$active_procs" ]]; then
  printf 'cleanup-builds: processo(s) ativo(s) detectado(s), remoção será conservadora:\n%s\n' "$active_procs" >&2
fi

# Snapshot de caminhos abertos (cwd + descritores) de todos os processos.
open_paths="$(
  for link in /proc/[0-9]*/cwd /proc/[0-9]*/fd/*; do
    readlink -f "$link" 2>/dev/null || true
  done
)"

# Diretórios candidatos com uso real: algum processo os referencia agora.
in_use_dirs=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  case "$path" in
    *'/.next-'*) ;;
    *) continue ;;
  esac
  for dir in "${candidates[@]}"; do
    abs="$ROOT_DIR/$dir"
    if [[ "$path" == "$abs" || "$path" == "$abs"/* ]]; then
      in_use_dirs+=("$dir")
      break
    fi
  done
done <<< "$open_paths"

if [[ -n "$active_procs" ]]; then
  for dir in "${candidates[@]}"; do
    if printf '%s\n' "$active_procs" | grep -qF -- "$dir"; then
      in_use_dirs+=("$dir")
    fi
  done
fi

dir_in_use() {
  local candidate
  for candidate in "${in_use_dirs[@]}"; do
    [[ "$candidate" == "$1" ]] && return 0
  done
  return 1
}

removed=()
skipped=()
freed_bytes=0

for dir in "${candidates[@]}"; do
  if dir_in_use "$dir"; then
    skipped+=("$dir")
    printf 'cleanup-builds: EM USO (preservado): %s\n' "$dir" >&2
    continue
  fi
  size="$(du -sb "$dir" 2>/dev/null | cut -f1 || echo 0)"
  freed_bytes=$((freed_bytes + ${size:-0}))
  rm -rf -- "$dir"
  removed+=("$dir")
done

printf 'cleanup-builds: removido(s)=%d, preservado(s) em uso=%d, liberado≈%d MiB\n' \
  "${#removed[@]}" "${#skipped[@]}" "$((freed_bytes / 1024 / 1024))"

# Diretórios .next-* fora dos padrões autorizados: apenas reportados, nunca removidos.
shopt -s nullglob
leftovers=()
for dir in .next-*; do
  [[ -d "$dir" ]] || continue
  matched=0
  for pattern in "${PATTERNS[@]}"; do
    case "$dir" in
      $pattern) matched=1; break ;;
    esac
  done
  ((matched == 1)) || leftovers+=("$dir")
done
shopt -u nullglob
if ((${#leftovers[@]} > 0)); then
  printf 'cleanup-builds: fora dos padrões autorizados, NÃO removido(s): %s\n' "${leftovers[*]}"
fi

# AUD-004/AUD-005: poda do tsconfig.json — globs `include` de diretórios .next-* inexistentes.
python3 - <<'PY'
import glob
import json
import os

path = "tsconfig.json"
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

include = data.get("include", [])
kept = []
pruned = []
for entry in include:
    root = entry.split("/", 1)[0]
    if not root.startswith(".next-"):
        kept.append(entry)
        continue
    if any(token in root for token in "*?["):
        exists = bool(glob.glob(root))
    else:
        exists = os.path.isdir(root)
    if exists:
        kept.append(entry)
    else:
        pruned.append(entry)

if pruned:
    data["include"] = kept
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

print(
    "cleanup-builds tsconfig.json: %d include glob(s) de build removido(s), %d mantido(s)."
    % (len(pruned), len(kept))
)
PY

# O artefato gerado next-env.d.ts pode importar tipos de um distDir removido — realinha
# para o build ativo `.next/` (arquivo gerado e gitignorado; nada versionável é alterado).
python3 - <<'PY'
import os
import re

path = "next-env.d.ts"
if not os.path.exists(path):
    raise SystemExit(0)

with open(path, encoding="utf-8") as handle:
    lines = handle.read().splitlines(keepends=True)

patterns = [
    re.compile(r'^(\s*import\s+")\./(\.next-[^/"]+)(/[^"]+)("\s*;?)\s*$'),
    re.compile(r'^(\s*///\s*<reference\s+path=")\./(\.next-[^/"]+)(/[^"]+)("\s*/>)\s*$'),
]

out = []
changed = False
for line in lines:
    match = None
    for pattern in patterns:
        match = pattern.match(line.rstrip("\n"))
        if match:
            break
    if not match:
        out.append(line)
        continue
    prefix, dist_dir, rest, suffix = match.groups()
    if os.path.isdir(dist_dir):
        out.append(line)
        continue
    target = "./.next" + rest
    if os.path.exists(target):
        out.append("%s%s%s\n" % (prefix, target, suffix))
        changed = True
        print("cleanup-builds next-env.d.ts: ./%s%s -> %s" % (dist_dir, rest, target))
    else:
        changed = True
        print("cleanup-builds next-env.d.ts: linha descartada (alvo inexistente): ./%s%s" % (dist_dir, rest))

if changed:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("".join(out))
PY

echo 'cleanup-builds: concluído.'
