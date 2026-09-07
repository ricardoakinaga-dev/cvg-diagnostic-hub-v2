# AAA-3 — browser PostgreSQL production-like disposable lane — 2026-09-06

## Resultado

**PASS local condicional** — 51/51 Playwright scenarios passed across the
Chromium, tablet and mobile projects with `--retries=0 --fail-on-flaky-tests`.
The run used a
production `next start`, a disposable PostgreSQL 16.15 cluster, an independent
durable outbox worker, an S3-compatible HTTP service, and an HTTPS malware
scanner service. No persistent PostgreSQL instance was used.

This is stronger evidence than the earlier local-storage snapshot packet, but
it is not a production or hospital acceptance result: the object store and
scanner are synthetic in-process services, Node 22/remote CI were not run on
this host, and clinical policy, workload, recovery, and human gates remain
open.

## Environment

- PostgreSQL 16.15, loopback-only disposable cluster on port `55450`; database
  `cvg_test_e2e`; migrations `001`–`010` and explicit synthetic seed.
- Next.js `16.3.0` production bundle served by `next start` on
  `127.0.0.1:3115`; `/api/v1/readyz` accepted `dataMode=postgres` and
  `storageMode=s3`.
- S3-compatible service and HTTPS scanner started by
  `npm run ci:storage-services`; the scanner certificate was disposable and
  trusted only by `NODE_EXTRA_CA_CERTS` for this run. The clinical attachment
  flow exercised upload, clean scan, persistence and download.
- `OUTBOX_INLINE_LOCAL=false`, `OUTBOX_SINK=postgres`, `OUTBOX_DELIVERY_CHANNEL=IN_APP`,
  and a separate `npm run outbox:worker` process. The critical-result journey
  therefore required durable relational delivery confirmation.
- Critical policy was synthetic and explicitly configured with version,
  approval reference and timestamp. No clinical policy approval was inferred.

## Coverage observed

| Suite | Result |
| --- | ---: |
| `tests/e2e/accessibility.spec.ts` | 6/6 |
| `tests/e2e/clinical-lifecycle.spec.ts` | 9/9 |
| `tests/e2e/core-flows.spec.ts` | 36/36 |
| **Total** | **51/51** |

The run covered dashboard/context, administration, request creation, narrow
navigation, Patient Workspace snapshot and degraded refresh, Lab and RX
lifecycles, attachment upload/download, notification/review/amend/void, and
critical-result acknowledgement. No retry was accepted.

## Clean visual artifacts

The responsive Patient Workspace scenario in this same `next start` run wrote
clean full-page PNGs without the Next development overlay:

- `production-chromium-1440-20260906.png` — SHA-256 `a415367b6110cf1edca4b3a407d684065d949461df8df055ab1d6a64209285a2`.
- `production-tablet-834-20260906.png` — SHA-256 `2cb8d955be650d76ec4bd7016e5303a6d706abf3a17fb87c231d54f489700c1c`.
- `production-mobile-375-20260906.png` — SHA-256 `3d7647ef6ff71841fd3d65f917182bc738bdc5008a3a9278b638a51e96772b5b`.
- `production-dense-mobile-collapsed-375-20260906.png` — SHA-256 `3bd8fefbf08efa2a5961ce7a6a7eae919741d4566cc1e9bfdc267ea02cb65b93`.
- `production-dense-mobile-expanded-375-20260906.png` — SHA-256 `6b675820b55664ddcdbca0a8cc2728167a285f411070038f760ec77461cb29e2`.

The mobile dense fixture contains 12 deterministic audit events. The collapsed
capture shows the bounded 8-event preview and `Mostrar mais eventos`; the
expanded capture shows all 12 events and `Mostrar menos eventos`, with no
observed clipping.

The files are retained under
`.orchestrate/evidence/visual-patient-workspace-20260906/`. They demonstrate
the ready state only; the visual ledger separately records missing state
captures, manual review and target/human acceptance.

## Defect found and fixed before the passing run

The first real worker-enabled attempt exposed that the default JSONB-authority
runtime did not project a newly created notification into the relational table
required by `notification_deliveries`. The narrow projection seam in
`src/server/store/postgres-store.ts` now upserts the recipient user and
notification atomically with the snapshot transaction. A second run exposed a
schema mismatch (`notifications.updated_at` does not exist); the update was
corrected to use the table's version/state columns only.

The PostgreSQL integration suite now includes a regression that creates a
notification, verifies its relational projection, processes its outbox message
through the PostgreSQL sink, and verifies `notification_deliveries.status =
'DELIVERED'` plus the JSONB state transition.

## Local evidence executed after the fix

- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `git diff --check` — PASS.
- Historical `npm run test:postgres` evidence on a separate disposable
  PostgreSQL 16.15 cluster is **30/30**; that result predates the new
  `relational-sample-lineage.integration.test.ts`. The new integration test is
  present but was not rerun here because no disposable PostgreSQL runtime was
  available; persistent `127.0.0.1:5432` was not touched.
- Production browser lane above — **51/51**, no retries, including Chromium,
  tablet and mobile projects.
- The current local unit/coverage lane is 614/614 in 75 files; its configured
  denominator still excludes some UI/page/runtime and PostgreSQL adapter code,
  so it is not the AAA-2 G4 broad-coverage acceptance.

## Limits

This packet does not prove relational clinical cutover: JSONB remains the
runtime authority and the projection is deliberately a narrow delivery seam.
It does not prove real S3, real AV, target TLS/proxy/IdP, restart/failover,
representative load, restore/RPO/RTO, remote CI, manual accessibility,
clinical governance, or release approval.
