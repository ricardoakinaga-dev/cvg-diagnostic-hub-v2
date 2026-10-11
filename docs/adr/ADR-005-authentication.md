# ADR-005 — Session authentication and identity boundary

- Status: Accepted for the pilot (D1, D-032); hospital federation remains a later decision
- Date: 2026-08-18
- Reconciled: 2026-10-11

## Context

Hospital identity provider is unknown. Browser-stored bearer tokens increase exposure; identity must be replaceable without rewriting authorization.

## Decision

Use the Hub's local accounts for the pilot, as approved on 08/10/2026 in D1 / D-032. Authentication stays separate from authorization so a future hospital identity integration can preserve server-side roles and scopes. OIDC/AD and an `IdentityProvider` adapter are future work; no such adapter is implemented or required to start this approved pilot.

Use opaque, revocable server-side sessions with HttpOnly/Secure/SameSite cookies and CSRF protection. With `SESSION_SECRET` configured, the persisted token fingerprint is HMAC-SHA256 and carries a derived secret-generation identifier. Every session authorization, including an existing realtime stream, checks that generation. Rotating the secret on all application instances invalidates old cookies and pending password-reset links without rewriting the session records. Legacy unkeyed sessions are accepted only in development/test without a configured secret; production fails closed without a secret of at least 32 characters.

## Alternatives

JWT in localStorage, a custom identity system as permanent source, direct provider coupling.

## Consequences

Requires durable session storage and coordinated rotation across all application instances; mixed secrets during a rollout are not a supported rotation procedure. Pilot production readiness still requires institutional account ownership, approved access, operating procedures and security acceptance. Reassess federation after the pilot instead of treating the former OQ-012 as an unresolved choice for D1.
