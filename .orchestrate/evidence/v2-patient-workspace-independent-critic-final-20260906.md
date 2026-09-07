# Patient Workspace — fresh post-fix visual reinspection

Observed on 2026-09-06 by Wegener in a fresh read-only pass. No files were
edited, no tests were rerun, and PostgreSQL was not accessed.

## Verdict

`CONDITIONAL` for the bounded local visual slice. The rendered UI issues from
the prior pass are closed, but this is not an unconditional visual approval,
AAA approval, production acceptance, clinical acceptance or release decision.

## Verified current evidence

- Known department labels are localized and unknown department codes are not
  echoed by the domain projection; the matching domain regressions pass.
- The owner value wraps completely on desktop/tablet as well as on mobile,
  320px and the 188px explicit extreme proxy. No horizontal or critical-region
  overflow is visible in the current captures.
- Current main captures are 1440×2229, 834×3153 and 1031×10027 native pixels;
  their hashes match the current ledger after the final no-retry E2E run.
- After the independent inspection, the coordinator reran the final no-retry
  E2E and synchronized those three primary PNGs; the coordinator's hash/dimension
  recheck is recorded in `VER-V2-PATIENT-WORKSPACE-RESPONSIVE-015`. This later
  capture sync does not upgrade the independent verdict.
- Current stress/transient captures cover 188px, 320px, 375px long-copy and
  nine-digit values, initial loading and pagination loading. The loading
  skeleton preserves the workspace structure; pagination keeps the confirmed
  first page visible while showing `Carregando…`.
- Packet and metrics agree on LCP `892/464/404/388 ms` and CLS `0` across
  desktop, tablet, mobile and reduced-motion captures.
- All 19 manifest paths exist and the recomputed digest
  `8ef1ff59b3ceb042e221386e81b2ece6424010da3c12099fc7ef76a33418d10f` matches
  the packet, ledger and current summary.

## Remaining boundary

The final ledger remains `REVIEW REQUIRED`/`CONDITIONAL` because the evidence
is local synthetic-memory Playwright/Chrome, the 188px case is a declared
proxy, CLS is not a full loading-to-ready production trace, screenshots retain
the Next development overlay, and manual screen-reader/touch review,
product-golden comparison, target/production performance, clinical/hospital
acceptance and human release authority are unavailable.
