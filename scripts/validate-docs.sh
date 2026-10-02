#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

# AUD-002: um único motor de busca para TODAS as classes de checagem.
# `rg` quando existe; senão fallback explícito com grep equivalente.
# Sem nenhum dos dois a validação aborta (exit != 0) — nunca aprova em silêncio.
ENGINE=""
REPORT_ENGINE=""
if command -v rg >/dev/null 2>&1; then
  ENGINE="rg"
  REPORT_ENGINE="rg"
elif command -v grep >/dev/null 2>&1; then
  ENGINE="grep"
  REPORT_ENGINE="grep (-F / -rInE / -oE; rg ausente)"
else
  printf 'FATAL: nenhum motor de busca disponível (rg e grep ausentes).\n' >&2
  printf 'Validação abortada antes de qualquer checagem — nada foi aprovado.\n' >&2
  exit 2
fi
printf 'Documentation validation engine: %s\n' "$REPORT_ENGINE"

require_file() {
  local path="$1"
  if [[ ! -s "$path" ]]; then
    printf 'MISSING_OR_EMPTY: %s\n' "$path" >&2
    failures=$((failures + 1))
  fi
}

# rc: 0 = encontrado, 1 = não encontrado, >=2 = erro do motor.
text_found() {
  local path="$1"
  local text="$2"
  if [[ "$ENGINE" == "rg" ]]; then
    rg -Fq -- "$text" "$path"
  else
    grep -Fq -- "$text" "$path"
  fi
}

require_text() {
  local path="$1"
  local text="$2"
  local rc=0
  text_found "$path" "$text" || rc=$?
  if (( rc != 0 )); then
    printf 'MISSING_TEXT: %s -> %s\n' "$path" "$text" >&2
    failures=$((failures + 1))
  fi
}

required_files=(
  README.md QUESTIONS.md docs/README.md docs/GLOSSARY.md docs/DECISION_LOG.md docs/TRACEABILITY_MATRIX.md
  docs/operations/DEPLOYMENT.md docs/RELATORIO_AUDITORIA_2026-10-02.md docs/build/PRODUCTION_PLAN.md docs/build/PRODUCTION_ROADMAP.md docs/build/PRODUCTION_BACKLOG.md
  docs/discovery/DISCOVERY.md docs/discovery/STAKEHOLDERS.md docs/discovery/PERSONAS.md
  docs/discovery/JOBS_TO_BE_DONE.md docs/discovery/USER_JOURNEYS.md docs/discovery/SERVICE_BLUEPRINT.md
  docs/discovery/EVENT_STORMING.md docs/discovery/ASSUMPTIONS.md docs/discovery/OPEN_QUESTIONS.md
  docs/discovery/RISKS.md docs/discovery/SUCCESS_METRICS.md
  docs/prd/PRD.md
  docs/spec/SYSTEM_SPEC.md docs/spec/DOMAIN_MODEL.md docs/spec/STATE_MACHINES.md docs/spec/DATA_MODEL.md
  docs/spec/PERMISSIONS.md docs/spec/NOTIFICATIONS.md docs/spec/SEARCH.md docs/spec/ERROR_MODEL.md docs/spec/REALTIME.md docs/spec/API_SPEC.md
  docs/architecture/ARCHITECTURE.md docs/architecture/COMPONENTS.md docs/architecture/DATA_FLOW.md
  docs/ux/INFORMATION_ARCHITECTURE.md docs/ux/USER_FLOWS.md docs/ux/SCREEN_SPECIFICATIONS.md docs/ux/DESIGN_SYSTEM.md
  docs/api/API_SPEC.md docs/security/SECURITY.md docs/security/THREAT_MODEL.md docs/testing/TEST_PLAN.md
  docs/operations/BACKUP_RESTORE.md docs/operations/OBSERVABILITY.md docs/operations/PRODUCTION_READINESS.md docs/operations/RELEASE_CHECKLIST.md
  docs/build/BUILD_PLAN.md docs/build/BACKLOG.md
  docs/build/AAA_2_BACKLOG.md docs/build/AAA_2_DECISION_REGISTER.md docs/build/AAA_2_EXECUTIVE_PLAN.md
  docs/build/AAA_2_QUALITY_BAR.md docs/build/AAA_2_ROADMAP.md docs/build/EXECUTIVE_IMPROVEMENT_PLAN.md
  docs/build/STATE_OF_ART_BACKLOG.md docs/build/STATE_OF_ART_QUALITY_BAR.md docs/build/STATE_OF_ART_ROADMAP.md
  docs/v2/MIGRATION_MAP.md docs/v2/PATIENT_WORKSPACE.md docs/v2/QUALITY_BAR.md docs/v2/RELATIONAL_SAMPLE_LINEAGE.md
  docs/testing/POSTGRES_INTEGRATION.md docs/PROJECT_STATUS_REPORT.md docs/RELATORIO_AUDITORIA_2026-09-05.md
  docs/api/openapi.json
  docs/adr/README.md docs/adr/ADR-001-modular-monolith.md docs/adr/ADR-002-postgresql.md
  docs/adr/ADR-003-realtime-sse.md docs/adr/ADR-004-storage.md docs/adr/ADR-005-authentication.md
  docs/adr/ADR-006-result-versioning.md docs/adr/ADR-007-outbox.md docs/adr/ADR-008-identifiers.md
  docs/RELATORIO_AUDITORIA_2026-09-07.md
  docs/RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md
  docs/RELATORIO_FRONTEND_STATE_OF_ART_ADDENDUM_2026-09-07.md
  docs/v2/LABORATORY_VERTICAL.md
  docs/RELATORIO_AUDITORIA_2026-10-01.md
  docs/build/AUDIT_2026_10_EXECUTIVE_PLAN.md
  docs/build/AUDIT_2026_10_ROADMAP.md
  docs/build/AUDIT_2026_10_BACKLOG.md
  .gauntlet/state.md .gauntlet/progress.md
)

for file in "${required_files[@]}"; do
  require_file "$file"
done

require_text docs/discovery/DISCOVERY.md 'FACT'
require_text docs/discovery/DISCOVERY.md 'ASSUMPTION'
require_text docs/discovery/DISCOVERY.md 'DECISION'
require_text docs/discovery/DISCOVERY.md 'OPEN QUESTION'
require_text docs/discovery/EVENT_STORMING.md 'DiagnosticRequestCreated'
require_text docs/discovery/USER_JOURNEYS.md 'Fluxo A'
require_text docs/discovery/USER_JOURNEYS.md 'Fluxo G'
require_text docs/prd/PRD.md '## 8. MVP scope — MoSCoW'
require_text docs/prd/PRD.md '## 9. Functional requirements'
require_text docs/prd/PRD.md '## 10. Non-functional requirements'
require_text docs/prd/PRD.md 'AC-FR-RESULT-002-01'
require_text docs/spec/STATE_MACHINES.md '## 2. DiagnosticRequestItem'
require_text docs/spec/STATE_MACHINES.md '## 5. Result lifecycle/version'
require_text docs/spec/DATA_MODEL.md '## 11. ERD (MVP core)'
require_text docs/spec/PERMISSIONS.md 'Action matrix'
require_text docs/spec/REALTIME.md 'Last-Event-ID'
require_text docs/api/API_SPEC.md '/api/v1'
require_text docs/security/THREAT_MODEL.md 'IDOR'
require_text docs/testing/TEST_PLAN.md 'TEST-FR-RESULT-004-01'
require_text docs/operations/PRODUCTION_READINESS.md 'NOT READY'
require_text docs/build/BUILD_PLAN.md 'M0 — Foundation and contracts'
require_text docs/build/BACKLOG.md 'BLD-HARD-004'
require_text docs/TRACEABILITY_MATRIX.md 'Problem'

# Any product placeholder in a planning document is a gap, not a harmless note.
PLACEHOLDER_PCRE='\b(TODO|TBD|FIXME|PLACEHOLDER)\b|[Ll]orem [Ii]psum'
PLACEHOLDER_ERE='(^|[^[:alnum:]_])(TODO|TBD|FIXME|PLACEHOLDER)([^[:alnum:]_]|$)|[Ll]orem [Ii]psum'
if [[ "$ENGINE" == "rg" ]]; then
  placeholder_pattern="$PLACEHOLDER_PCRE"
else
  placeholder_pattern="$PLACEHOLDER_ERE"
fi

search_md_lines() {
  if [[ "$ENGINE" == "rg" ]]; then
    rg -n -e "$1" -g '*.md' README.md QUESTIONS.md docs
  else
    grep -rnE --include='*.md' -- "$1" README.md QUESTIONS.md docs
  fi
}

placeholder_rc=0
placeholder_hits="$(search_md_lines "$placeholder_pattern")" || placeholder_rc=$?
if (( placeholder_rc == 0 )); then
  printf '%s\n' "$placeholder_hits" >&2
  failures=$((failures + 1))
elif (( placeholder_rc > 1 )); then
  printf 'SEARCH_ERROR: varredura de placeholders incompleta (motor=%s rc=%d).\n' "$REPORT_ENGINE" "$placeholder_rc" >&2
  failures=$((failures + 1))
fi

extract_req_ids() {
  if [[ "$ENGINE" == "rg" ]]; then
    rg -o '^\| (FR|NFR)-[A-Z0-9-]+' docs/prd/PRD.md | sed 's/^| //' | sort -u
  else
    grep -oE '^\| (FR|NFR)-[A-Z0-9-]+' docs/prd/PRD.md | sed 's/^| //' | sort -u
  fi
}

extract_ac_ids() {
  if [[ "$ENGINE" == "rg" ]]; then
    rg -o 'AC-[A-Z0-9-]+' docs/prd/PRD.md | sort -u
  else
    grep -oE 'AC-[A-Z0-9-]+' docs/prd/PRD.md | sort -u
  fi
}

# Every PRD requirement and acceptance criterion must be represented in the matrix.
req_ids=""
req_extract_rc=0
req_ids="$(extract_req_ids)" || req_extract_rc=$?
if (( req_extract_rc > 1 )); then
  printf 'SEARCH_ERROR: extração de requisitos do PRD incompleta (motor=%s rc=%d).\n' "$REPORT_ENGINE" "$req_extract_rc" >&2
  failures=$((failures + 1))
fi

while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  rc=0
  text_found docs/TRACEABILITY_MATRIX.md "$id" || rc=$?
  if (( rc != 0 )); then
    printf 'ORPHAN_REQUIREMENT: %s\n' "$id" >&2
    failures=$((failures + 1))
  fi
done <<< "$req_ids"

ac_ids=""
ac_extract_rc=0
ac_ids="$(extract_ac_ids)" || ac_extract_rc=$?
if (( ac_extract_rc > 1 )); then
  printf 'SEARCH_ERROR: extração de critérios de aceite do PRD incompleta (motor=%s rc=%d).\n' "$REPORT_ENGINE" "$ac_extract_rc" >&2
  failures=$((failures + 1))
fi

while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  rc=0
  text_found docs/TRACEABILITY_MATRIX.md "$id" || rc=$?
  if (( rc != 0 )); then
    printf 'ORPHAN_ACCEPTANCE: %s\n' "$id" >&2
    failures=$((failures + 1))
  fi
done <<< "$ac_ids"

# Resolve local Markdown links without fetching the network.
if ! python3 - <<'PY'
from pathlib import Path
import re
import sys

root = Path.cwd()
files = [root / "README.md", root / "QUESTIONS.md", *sorted((root / "docs").rglob("*.md")), *sorted((root / ".gauntlet").glob("*.md"))]
pattern = re.compile(r"\]\(([^)]+)\)")
bad = []

for source in files:
    content = source.read_text(encoding="utf-8")
    for raw in pattern.findall(content):
        target = raw.strip().split("#", 1)[0].split("?", 1)[0]
        if not target or target.startswith(("http://", "https://", "mailto:")):
            continue
        target = target.strip("<>")
        resolved = (source.parent / target).resolve()
        if not resolved.exists():
            bad.append(f"{source.relative_to(root)} -> {raw}")

if bad:
    for item in bad:
        print(f"BROKEN_LOCAL_LINK: {item}", file=sys.stderr)
    sys.exit(1)
PY
then
  failures=$((failures + 1))
fi

# Ensure canonical high-risk vocabulary is present in its normative sources.
for term in 'RECOLLECTION_REQUIRED' 'RESULT_AVAILABLE' 'ResultAmended' 'CriticalResultDetected' 'Idempotency-Key' '409 CONFLICT'; do
  rc=0
  if [[ "$ENGINE" == "rg" ]]; then
    rg -Fq -- "$term" docs/spec docs/api docs/security || rc=$?
  else
    grep -rFq -- "$term" docs/spec docs/api docs/security || rc=$?
  fi
  if (( rc != 0 )); then
    printf 'MISSING_CANONICAL_TERM: %s\n' "$term" >&2
    failures=$((failures + 1))
  fi
done

if (( failures > 0 )); then
  printf 'Documentation validation FAILED with %d issue(s) (motor: %s).\n' "$failures" "$REPORT_ENGINE" >&2
  exit 1
fi

printf 'Documentation validation PASS: %d required files and cross-document gates checked (motor: %s).\n' "${#required_files[@]}" "$REPORT_ENGINE"
