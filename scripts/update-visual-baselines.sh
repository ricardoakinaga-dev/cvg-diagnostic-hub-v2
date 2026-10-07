#!/usr/bin/env bash
# Regenerates the Playwright visual baselines inside the exact image the CI
# browser job uses. Baselines captured with the host Chrome differ in font
# rendering and fail CI (the 06/10/2026 run failed this way).
#
#   npm run test:visual:update
set -Eeuo pipefail

# Keep in sync with jobs.browser.container in .github/workflows/ci.yml.
IMAGE="mcr.microsoft.com/playwright:v1.55.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="tests/e2e/visual.spec.ts-snapshots"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if ! grep -qF "$IMAGE" "$REPO_ROOT/.github/workflows/ci.yml"; then
  echo "The CI browser image changed; update IMAGE in this script first." >&2
  exit 1
fi

# Copy the working tree (tracked and untracked, honoring .gitignore), so
# uncommitted UI changes are captured while local node_modules and build
# output never leak into the container.
(cd "$REPO_ROOT" && git ls-files -z --cached --others --exclude-standard \
  | tar --null --ignore-failed-read -T - -cf - 2>/dev/null) | tar -x -C "$WORK_DIR"

docker run --rm --ipc=host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e CI=1 -e NEXT_TELEMETRY_DISABLED=1 \
  -v "$WORK_DIR:/work" -w /work \
  "$IMAGE" \
  bash -c 'mkdir -p /tmp/home && npm ci --no-audit --no-fund >/dev/null \
    && npx playwright test tests/e2e/visual.spec.ts --update-snapshots --retries=0 \
    && npx playwright test tests/e2e/visual.spec.ts --retries=0'

cp "$WORK_DIR/$SNAPSHOT_DIR"/*.png "$REPO_ROOT/$SNAPSHOT_DIR/"
echo "Visual baselines updated in $SNAPSHOT_DIR; review the images before committing."
