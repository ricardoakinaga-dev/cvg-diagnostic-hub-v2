#!/usr/bin/env bash
# Every release trigger, including workflow_dispatch, must prove that the exact candidate passed the latest push CI
# on this repository's main branch. An older success cannot mask a pending, cancelled or failed rerun.
set -Eeuo pipefail
repository="${RELEASE_REPOSITORY:-}"
commit="${RELEASE_COMMIT:-}"
GH="${GH:-gh}"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "RELEASE_REPOSITORY and a full RELEASE_COMMIT are required" >&2; exit 2; }
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
"$GH" api --method GET "repos/$repository/actions/workflows/ci.yml/runs" \
  -f branch=main -f event=push -f "head_sha=$commit" -f per_page=100 > "$work_dir/runs.json"
node - "$work_dir/runs.json" "$repository" "$commit" <<'NODE'
const { readFileSync } = require("node:fs");
const [file, repository, commit] = process.argv.slice(2);
try {
  const response = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(response.workflow_runs)) throw new Error("CI API did not return workflow runs");
  const runs = response.workflow_runs.filter(run => run.head_sha === commit && run.head_branch === "main" &&
    run.event === "push" && run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase());
  runs.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const latest = runs[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("the latest main push CI for this exact commit must be completed and successful");
  }
  console.log(JSON.stringify({ event: "release.ci_verified", commit, runId: latest.id, attempt: latest.run_attempt }));
} catch (error) {
  console.error(JSON.stringify({ event: "release.ci_refused", message: error.message }));
  process.exitCode = 1;
}
NODE
