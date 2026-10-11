import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { PasswordResetGrant, StateStore, StoreState, User } from "../domain/models";
import { findById } from "../domain/state-index";
import { ApiError } from "../http/envelope";
import { hashPassword } from "./password";
import { assertAcceptablePassword, type BreachCheckEnvironment } from "./password-policy";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const INVALID_MESSAGE = "Link de redefinição inválido ou expirado.";

export function passwordResetTtlMs(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number(environment.PASSWORD_RESET_TTL_MS);
  if (!Number.isFinite(parsed) || environment.PASSWORD_RESET_TTL_MS?.trim() === "") return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(parsed)));
}

const RESET_TOKEN_PEPPER_FALLBACK = "cvg-reset-token-pepper";

function resetTokenPepper(environment: Readonly<Record<string, string | undefined>>): string {
  const secret = environment.SESSION_SECRET?.trim();
  if (environment.NODE_ENV === "production" && (!secret || secret.length < 32)) {
    throw new ApiError("PASSWORD_RESET_INVALID", INVALID_MESSAGE, 400);
  }
  return secret || RESET_TOKEN_PEPPER_FALLBACK;
}

/**
 * Fingerprint of the reset token, keyed by the server secret: scrypt over the
 * 32 random bytes with SESSION_SECRET as salt. A copy of the users table alone
 * cannot be turned into a usable link, and rotating SESSION_SECRET voids every
 * pending link (sessions die with it anyway).
 */
export function hashResetToken(token: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const pepper = resetTokenPepper(environment);
  return scryptSync(token, pepper, 32).toString("hex");
}

/** Builds a fresh grant; the plaintext token is returned once and never stored. */
export function createPasswordResetGrant(issuedBy: string, environment: Readonly<Record<string, string | undefined>> = process.env, nowMs = Date.now()): { token: string; grant: PasswordResetGrant } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    grant: { tokenHash: hashResetToken(token, environment), issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + passwordResetTtlMs(environment)).toISOString(), issuedBy }
  };
}

export function passwordResetUrl(token: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const origin = (environment.APP_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return `${origin}/reset-password?token=${token}`;
}

/** Hash comparison in constant time; scans every pending grant so timing does not reveal which one matched. */
function userForToken(state: StoreState, tokenHash: string): User | undefined {
  const wanted = Buffer.from(tokenHash, "hex");
  let match: User | undefined;
  for (const user of state.users) {
    if (!user.passwordReset) continue;
    const candidate = Buffer.from(user.passwordReset.tokenHash, "hex");
    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) match = user;
  }
  return match;
}

/**
 * AUD-06: a pending link belongs to the credential and the access it was issued under. A password change, a
 * regenerated password, an access change or a deactivation drops it in the same transaction.
 */
export function withoutPendingReset(user: User): { user: User; revoked: boolean } {
  if (!user.passwordReset) return { user, revoked: false };
  const { passwordReset: _revoked, ...rest } = user;
  return { user: rest, revoked: true };
}

function invalid(): ApiError {
  return new ApiError("PASSWORD_RESET_INVALID", INVALID_MESSAGE, 400);
}

function rejectionAudit(correlationId: string, reason: "EXPIRED" | "INVALID", entityId: string) {
  return {
    id: `audit_${randomUUID()}`, eventType: "PasswordResetRejected", entityType: "PasswordReset", entityId, correlationId,
    metadata: { reason }, occurredAt: new Date().toISOString()
  };
}

async function recordRejection(store: StateStore, correlationId: string, reason: "EXPIRED" | "INVALID", entityId: string): Promise<void> {
  await store.transaction((state) => ({ state: { ...state, auditEvents: [...state.auditEvents, rejectionAudit(correlationId, reason, entityId)] }, result: undefined }));
}

/**
 * Public completion of an administrator-issued reset (PROD-202). The token is
 * single use: it is cleared in the same transaction that stores the new hash,
 * every session of the person is revoked, and no session is created here, so
 * the public endpoint can never mint a login. Unknown, expired, reused and
 * deactivated cases answer identically (no oracle); only the audit differs.
 */
export async function completePasswordReset(
  store: StateStore,
  token: string,
  password: string,
  correlationId: string,
  environment: BreachCheckEnvironment = process.env
): Promise<{ email: string }> {
  const tokenPepper = resetTokenPepper(environment);
  const tokenHash = hashResetToken(token, environment);
  const state = await store.readState();
  const user = userForToken(state, tokenHash);
  if (!user?.passwordReset) {
    await recordRejection(store, correlationId, "INVALID", "unknown");
    throw invalid();
  }
  if (Date.parse(user.passwordReset.expiresAt) <= Date.now() || !user.active) {
    await recordRejection(store, correlationId, "EXPIRED", user.id);
    throw invalid();
  }
  await assertAcceptablePassword(password, { email: user.email, displayName: user.displayName }, environment);
  const passwordHash = hashPassword(password);
  return store.transaction((current) => {
    const target = findById(current.users, user.id);
    const grant = target?.passwordReset;
    if (!target || !grant || grant.tokenHash !== tokenHash || resetTokenPepper(environment) !== tokenPepper || Date.parse(grant.expiresAt) <= Date.now() || !target.active) {
      throw invalid();
    }
    const { passwordReset: _consumed, ...rest } = target;
    const updated: User = { ...rest, passwordHash, mustChangePassword: false, version: target.version + 1 };
    const occurredAt = new Date().toISOString();
    const revoked = current.sessions.filter((session) => session.userId === target.id && !session.revokedAt).length;
    return {
      state: {
        ...current,
        users: current.users.map((entry) => entry.id === target.id ? updated : entry),
        sessions: current.sessions.map((session) => session.userId === target.id && !session.revokedAt ? { ...session, revokedAt: occurredAt, version: session.version + 1 } : session),
        auditEvents: [...current.auditEvents, {
          id: `audit_${randomUUID()}`, eventType: "PasswordResetCompleted", actorId: target.id, entityType: "User", entityId: target.id,
          previousState: "PASSWORD_RESET_PENDING", newState: "ACTIVE", correlationId, metadata: { sessionsRevoked: revoked }, occurredAt
        }]
      },
      result: { email: target.email }
    };
  });
}

export function parseResetLinkArgs(argv: readonly string[]): { email: string } {
  const index = argv.indexOf("--email");
  const email = index >= 0 ? argv[index + 1]?.trim().toLowerCase() : undefined;
  if (!email || email.startsWith("--")) throw new Error("Uso: password-reset-link.ts --email <email>");
  return { email };
}

/**
 * Break-glass (operator only, needs the database credential): issues a reset
 * grant for an existing ACTIVE user of any role, replacing a previous grant and
 * revoking the user's sessions. Audited with source CLI and no actor.
 */
export async function issueResetLinkByEmail(
  store: StateStore,
  email: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ userId: string; resetUrl: string; expiresAt: string }> {
  const normalized = email.trim().toLowerCase();
  const { token, grant } = createPasswordResetGrant("cli", environment);
  const userId = await store.transaction((state) => {
    const target = state.users.find((user) => user.email.toLowerCase() === normalized && user.active);
    if (!target) throw new Error("PASSWORD_RESET_USER_NOT_FOUND: usuário inexistente ou inativo.");
    const occurredAt = grant.issuedAt;
    return {
      state: {
        ...state,
        users: state.users.map((user) => user.id === target.id ? { ...user, passwordReset: grant, version: user.version + 1 } : user),
        sessions: state.sessions.map((session) => session.userId === target.id && !session.revokedAt ? { ...session, revokedAt: occurredAt, version: session.version + 1 } : session),
        auditEvents: [...state.auditEvents, {
          id: `audit_${randomUUID()}`, eventType: "PasswordResetLinkIssued", entityType: "User", entityId: target.id,
          newState: "PASSWORD_RESET_PENDING", correlationId: `corr_cli_${randomUUID()}`,
          metadata: { action: "CLI_PASSWORD_RESET_LINK", source: "CLI", role: target.role, expiresAt: grant.expiresAt, replacedPrevious: Boolean(target.passwordReset) },
          occurredAt
        }]
      },
      result: target.id
    };
  });
  return { userId, resetUrl: passwordResetUrl(token, environment), expiresAt: grant.expiresAt };
}
