# Gauntlet state — HTTP multi-instance continuation

Run: `cvg-aaa3-http-multinstance-20260906-r2`

This continuation targets the largest locally actionable gap left by the
previous conditional pass: an end-to-end HTTP proof with two independently
started Next.js instances sharing one disposable PostgreSQL database. The
target slice is login/session propagation, authorized reads, and PostgreSQL
LISTEN/NOTIFY wake-up of an SSE stream after a mutation.

This artifact is local synthetic evidence only. It cannot establish production
readiness, hospital policy approval, clinical validation, IdP integration,
durable deployment behavior, or human acceptance.
