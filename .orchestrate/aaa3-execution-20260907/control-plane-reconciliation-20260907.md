# Reconciliation of the engineering control plane — 2026-09-07

> **Superseded packet:** this reconciliation predates the dashboard search
> hardening. The current candidate is recorded in the manifest and the
> [`node22-current-revalidation-search-20260907.md`](node22-current-revalidation-search-20260907.md) packet.

## Purpose

Reconcile the canonical `.agent` state with the current AAA-3 candidate after the
latest local implementation and verification slice. This record does not grant
clinical, hospital, target-environment or release authority.

## Current candidate

- Git head: `01bb1804682b4bb503e00e41c1361dc704d2294d`.
- Working tree: intentionally dirty; existing user and previous-agent changes
  remain preserved.
- Automated tests: `719/719` in `86` files under Node `22.23.2`.
- Coverage: `92.70%` lines, `86.06%` branches in the latest full run, and
  `94.40%` functions. Retained isolated V8 reruns from the preceding candidate
  observed `85.99–86.02%` branches; no threshold was lowered or denominator
  removed.
- Build: Next.js `16.3.0` / Turbopack, `15` application routes (`11` static,
  `4` dynamic).
- Browser matrix: `57/57`, no retries, Chromium/tablet/mobile, including the
  realtime and accessibility slices.
- Current AAA-3 manifest: `BLOCKED_REVIEW_REQUIRED`,
  `PASS_WITH_CONDITIONS`, `release_claim=false`.
- Post-hardening browser revalidation: `57/57` in `5.1m`, no retries, under
  Node `22.23.2`; packet: [`browser-e2e-node22-action-hardening-20260907.md`](browser-e2e-node22-action-hardening-20260907.md).

## Local hardening included in this reconciliation

The shared `ActionButton` transaction primitive now covers the remaining
high-risk client commands in patient creation, login, account logout,
notification acknowledgement and administration forms. The notification
acknowledgement keeps the control pending through server confirmation and the
subsequent reconciliation read; competing acknowledgement controls are blocked
while that transaction is unresolved. Focused regression coverage passed `21/21`
for the affected UI packages/components.

## Gates still open

- The JSONB snapshot remains runtime authority; relational projection and
  sample-lineage cutover are shadow-only.
- D-01 through D-06 require institutional identity, clinical policy, operations,
  privacy, infrastructure and pilot authority.
- Remote clean CI, target PostgreSQL/storage/scanner/secrets/TLS, representative
  load, failover, complete restore, RPO/RTO, manual accessibility/touch/zoom,
  clinical acceptance, hospital acceptance and release authority remain open.
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

## State transition

The canonical state remains `VERIFY/PARTIAL`; only its stale runtime summary and
evidence pointers were reconciled. It must not advance to `VERIFIED` or
`RELEASE_READY` from local automation alone.
