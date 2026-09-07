# Browser regression proof — Node 22, no retries

**Date:** 07/09/2026 06:00–06:04 BRT  
**Environment:** Node 22.23.2, local Playwright runtime, Chromium/tablet/mobile projects, isolated test servers.  
**Data classification:** synthetic only; no clinical or production data.

## Results

| Suite | Command setting | Result |
| --- | --- | ---: |
| Operational hub | `E2E_PORT_BASE=5960`, `tests/e2e/core-flows.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 36/36 |
| Accessibility | `E2E_PORT_BASE=6040`, `tests/e2e/accessibility.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 |
| Clinical lifecycle | `E2E_PORT_BASE=6080`, `tests/e2e/clinical-lifecycle.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 |

All three suites passed across Chromium, tablet and mobile. The accessibility suite includes selected axe checks, keyboard-visible controls, mobile `aria-current` uniqueness and 44px target assertions. The operational suite includes Patient Workspace focus/viewport checks under the fixed mobile navigation dock. No retry or flaky-test allowance was used.

## Commands

```sh
source /home/ricardo/.nvm/nvm.sh
nvm exec 22 env CI=1 E2E_PORT_BASE=5960 npx playwright test tests/e2e/core-flows.spec.ts --retries=0 --fail-on-flaky-tests
nvm exec 22 env CI=1 E2E_PORT_BASE=6040 npx playwright test tests/e2e/accessibility.spec.ts --retries=0 --fail-on-flaky-tests
nvm exec 22 env CI=1 E2E_PORT_BASE=6080 npx playwright test tests/e2e/clinical-lifecycle.spec.ts --retries=0 --fail-on-flaky-tests
```

## Limits

This packet proves local automated browser behavior only. Manual screen-reader, physical touch, zoom, hospital workflow and institutional clinical acceptance remain open. It also does not replace the separate production-like PostgreSQL/S3/scanner/outbox packet.

## Current revalidation after scanner/realtime hardening

The exact current artifact was re-run after the external scanner allowlist/redirect hardening, realtime delivery-state filter and mobile topbar correction:

| Suite | Command setting | Result |
| --- | --- | ---: |
| Operational hub | `E2E_PORT_BASE=6120`, `core-flows.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 36/36 in 2.4m |
| Clinical lifecycle | `E2E_PORT_BASE=6160`, `clinical-lifecycle.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 in 2.0m |
| Accessibility | `E2E_PORT_BASE=6200`, `accessibility.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 in 33.7s |

All three runs used Node 22.23.2 and passed across Chromium, tablet and mobile with no retry. The 20 fresh Patient Workspace captures and their verified hashes are in [`visual-patient-workspace-20260907`](../evidence/visual-patient-workspace-20260907/sha256-manifest.json).

## Current revalidation after structured HTTP logging and SBOM/coverage hardening

The same three suites were re-run after the route-level structured logger and CI evidence changes. No retry was enabled and the source tree used was the current candidate:

| Suite | Command setting | Result |
| --- | --- | ---: |
| Operational hub | `E2E_PORT_BASE=6120`, `core-flows.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 36/36 in 2.3m |
| Clinical lifecycle | `E2E_PORT_BASE=6160`, `clinical-lifecycle.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 in 2.1m |
| Accessibility | `E2E_PORT_BASE=6200`, `accessibility.spec.ts`, `--retries=0 --fail-on-flaky-tests` | 9/9 in 33.0s |

All current runs passed on Node 22.23.2 across Chromium, tablet and mobile. The logs emitted during the run do not include clinical bodies, credentials, tokens or cookies under the logger allowlist. Manual screen-reader, physical touch, zoom, hospital workflow and institutional clinical acceptance remain open.
