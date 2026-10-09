import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StateStore, StoreState, User } from "../domain/models";
import { sessionActivityTouchIntervalMs, sessionIsIdle, shouldTouchSessionActivity } from "../domain/session-activity";
import { ApiError } from "../http/envelope";
import * as passwordSecurity from "./password";
import { findById, sessionForTokenHash } from "../domain/state-index";
import { assertRateLimit } from "./rate-limit";
import { assertAcceptablePassword } from "./password-policy";
import { withoutPendingReset } from "./password-reset";

const SESSION_COOKIE = "cvg_session";
const CSRF_COOKIE = "cvg_csrf";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = "cvg-dummy-salt:fc81e88c18ea45b82209799aa84e44e5ad0fc2b898030079a3e8150af5121a36d7008c3a6ab0d31378dda1d4473e277fec45bf24617aed6cd62bbf26ef484308";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameScope(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const normalize = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  const malformedKeys = new Set<string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key || malformedKeys.has(key)) continue;
    const encodedValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(encodedValue);
    } catch {
      malformedKeys.add(key);
      delete cookies[key];
    }
  }
  return cookies;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getCsrfCookieName(): string {
  return CSRF_COOKIE;
}

export interface LoginOptions {
  /** Runs after credential revalidation; rejection prevents session creation. */
  beforeSessionCreate?: () => void | Promise<void>;
}

/** Distinguishes invalid credentials from a failed transactional revalidation. */
export class InvalidLoginCredentialsError extends ApiError {
  constructor() {
    super("UNAUTHENTICATED", "Credenciais inválidas.", 401);
  }
}

export async function loginUser(store: StateStore, email: string, password: string, options: LoginOptions = {}) {
  const state = await store.readState();
  const normalizedEmail = email.trim().toLowerCase();
  const user = state.users.find((candidate) => candidate.email.toLowerCase() === normalizedEmail && candidate.active);
  const passwordValid = passwordSecurity.verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordValid) {
    throw new InvalidLoginCredentialsError();
  }

  return store.transaction(async (currentState) => {
    const currentUser = findById(currentState.users, user.id);
    if (
      !currentUser
      || !currentUser.active
      || currentUser.email.toLowerCase() !== normalizedEmail
      || currentUser.passwordHash !== user.passwordHash
      || currentUser.version !== user.version
    ) {
      throw new ApiError("UNAUTHENTICATED", "Credenciais inválidas.", 401);
    }

    await options.beforeSessionCreate?.();
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString();
    const session = {
      id: randomBytes(16).toString("hex"),
      userId: user.id,
      tokenHash: hash(sessionToken),
      csrfTokenHash: hash(csrfToken),
      createdAt: createdAt.toISOString(),
      expiresAt,
      version: 1
    };
    return {
      state: { ...currentState, sessions: [...currentState.sessions, session] },
      result: { user: currentUser, sessionToken, csrfToken, expiresAt }
    };
  });
}

function activeUser(state: StoreState, userId: string): User | undefined {
  const user = findById(state.users, userId);
  return user?.active ? user : undefined;
}

export async function authenticateRequest(
  store: StateStore,
  request: Request,
  options: { requireCsrf?: boolean; allowPasswordChange?: boolean } = {}
): Promise<User> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) throw new ApiError("UNAUTHENTICATED", "Sessão necessária.", 401);
  const state = await store.readState();
  const session = sessionForTokenHash(state, hash(token));
  if (!session || sessionTerminallyExpired(session)) {
    throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
  }
  if (options.requireCsrf) assertCsrf(request, session.csrfTokenHash);
  const user = activeUser(state, session.userId);
  if (!user) throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
  await assertSessionIsActive(store, session);
  if (user.mustChangePassword && !options.allowPasswordChange) {
    throw new ApiError("PASSWORD_CHANGE_REQUIRED", "Troque sua senha inicial antes de continuar.", 403);
  }
  return { ...user, sessionId: session.id, reauthenticatedAt: session.reauthenticatedAt };
}

const PASSWORD_CHANGE_ATTEMPTS = 5;
const PASSWORD_CHANGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Stores the new hash, revokes every live session of the user and issues one
 * new session, in the caller's transaction. A stolen cookie dies with the old
 * password; the person changing it stays signed in on the rotated session.
 */
function rotateCredentials(
  state: StoreState,
  current: User,
  passwordHash: string,
  audit: { eventType: string; previousState: string; correlationId: string }
) {
  const pending = withoutPendingReset(current);
  const user = { ...pending.user, passwordHash, mustChangePassword: false, version: current.version + 1 };
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString();
  const session = { id: randomBytes(16).toString("hex"), userId: user.id, tokenHash: hash(sessionToken), csrfTokenHash: hash(csrfToken), createdAt, expiresAt, version: 1 };
  const revoked = state.sessions.filter((entry) => entry.userId === user.id && !entry.revokedAt).length;
  return {
    state: {
      ...state,
      users: state.users.map((entry) => entry.id === user.id ? user : entry),
      sessions: [...state.sessions.map((entry) => entry.userId === user.id && !entry.revokedAt ? { ...entry, revokedAt: createdAt, version: entry.version + 1 } : entry), session],
      auditEvents: [...state.auditEvents, {
        id: `audit_${randomBytes(16).toString("hex")}`, eventType: audit.eventType, actorId: user.id, entityType: "USER", entityId: user.id,
        previousState: audit.previousState, newState: "ACTIVE", correlationId: audit.correlationId, metadata: { sessionsRotated: true, sessionsRevoked: revoked, ...(pending.revoked ? { resetLinkRevoked: true } : {}) }, occurredAt: createdAt
      }]
    },
    result: { user, sessionToken, csrfToken, expiresAt }
  };
}

/** Replace temporary credentials and rotate every session in the same transaction. */
export async function changeInitialPassword(store: StateStore, request: Request, password: string, correlationId: string) {
  const actor = await authenticateRequest(store, request, { requireCsrf: true, allowPasswordChange: true });
  if (!actor.mustChangePassword) throw new ApiError("INVALID_STATE", "A senha inicial já foi substituída.", 409);
  await assertAcceptablePassword(password, { email: actor.email, displayName: actor.displayName });
  if (passwordSecurity.verifyPassword(password, actor.passwordHash)) {
    throw new ApiError("VALIDATION_ERROR", "Escolha uma senha diferente da senha inicial.", 400);
  }
  const passwordHash = passwordSecurity.hashPassword(password);
  return store.transaction((state) => {
    if (!authorizationSnapshotIsCurrent(state, actor, { allowPasswordChange: true })) throw new ApiError("SESSION_EXPIRED", "Entre novamente para trocar a senha.", 401);
    const current = findById(state.users, actor.id)!;
    if (!current.mustChangePassword || current.passwordHash !== actor.passwordHash) {
      throw new ApiError("SESSION_EXPIRED", "Entre novamente para trocar a senha.", 401);
    }
    return rotateCredentials(state, current, passwordHash, { eventType: "InitialPasswordChanged", previousState: "TEMPORARY_PASSWORD", correlationId });
  });
}

/**
 * Self-service password change (PROD-201): the current password is checked
 * outside the transaction (scrypt never holds the global write lock), attempts
 * are bounded per account, and every other session is revoked.
 */
export async function changeOwnPassword(store: StateStore, request: Request, currentPassword: string, newPassword: string, correlationId: string) {
  const actor = await authenticateRequest(store, request, { requireCsrf: true });
  await assertRateLimit(`password-change:${actor.id}`, PASSWORD_CHANGE_ATTEMPTS, PASSWORD_CHANGE_WINDOW_MS);
  await assertAcceptablePassword(newPassword, { email: actor.email, displayName: actor.displayName });
  if (!passwordSecurity.verifyPassword(currentPassword, actor.passwordHash)) {
    throw new ApiError("CURRENT_PASSWORD_INVALID", "A senha atual não confere.", 400);
  }
  if (passwordSecurity.verifyPassword(newPassword, actor.passwordHash)) {
    throw new ApiError("VALIDATION_ERROR", "Escolha uma senha diferente da atual.", 400);
  }
  const passwordHash = passwordSecurity.hashPassword(newPassword);
  return store.transaction((state) => {
    if (!authorizationSnapshotIsCurrent(state, actor)) throw new ApiError("SESSION_EXPIRED", "Entre novamente para trocar a senha.", 401);
    const current = findById(state.users, actor.id)!;
    if (current.passwordHash !== actor.passwordHash) throw new ApiError("SESSION_EXPIRED", "Entre novamente para trocar a senha.", 401);
    return rotateCredentials(state, current, passwordHash, { eventType: "PasswordChanged", previousState: "ACTIVE", correlationId });
  });
}

export function authorizationSnapshotIsCurrent(state: StoreState, actor: User, options: { allowPasswordChange?: boolean } = {}): boolean {
  const current = findById(state.users, actor.id);
  const sessionById = findById(state.sessions, actor.sessionId);
  const session = sessionById?.userId === actor.id ? sessionById : undefined;
  return Boolean(
    current?.active
    && (!current.mustChangePassword || options.allowPasswordChange === true)
    && current.version === actor.version
    && current.role === actor.role
    && current.departmentCode === actor.departmentCode
    && sameScope(current.patientIds, actor.patientIds)
    && sameScope(current.serviceCodes, actor.serviceCodes)
    && sameScope(current.managedDepartmentCodes, actor.managedDepartmentCodes)
    && session
    && !session.revokedAt
    && !sessionTerminallyExpired(session)
  );
}

export async function reauthenticateUser(store: StateStore, request: Request, password: string): Promise<User> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) throw new ApiError("UNAUTHENTICATED", "Sessão necessária.", 401);
  const tokenHash = hash(token);
  const state = await store.readState();
  const session = sessionForTokenHash(state, tokenHash);
  if (!session || sessionTerminallyExpired(session)) {
    throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
  }
  await assertSessionIsActive(store, session);
  const user = activeUser(state, session.userId);
  const passwordValid = passwordSecurity.verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordValid) {
    throw new ApiError("UNAUTHENTICATED", "Credenciais inválidas.", 401);
  }

  return store.transaction((currentState) => {
    const sessionById = findById(currentState.sessions, session.id);
    const currentSession = sessionById?.userId === session.userId && sessionById.tokenHash === tokenHash ? sessionById : undefined;
    if (
      !currentSession
      || currentSession.revokedAt
      || sessionTerminallyExpired(currentSession)
      || currentSession.version !== session.version
    ) {
      throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
    }
    const currentUser = findById(currentState.users, user.id);
    if (!currentUser || !currentUser.active) {
      throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
    }
    if (currentUser.passwordHash !== user.passwordHash || currentUser.version !== user.version) {
      throw new ApiError("UNAUTHENTICATED", "Credenciais inválidas.", 401);
    }
    const reauthenticatedAt = new Date().toISOString();
    const updatedSession = { ...currentSession, reauthenticatedAt, version: currentSession.version + 1 };
    return {
      state: { ...currentState, sessions: currentState.sessions.map((entry) => entry.id === currentSession.id ? updatedSession : entry) },
      result: { ...currentUser, sessionId: currentSession.id, reauthenticatedAt }
    };
  });
}

export async function revokeSession(store: StateStore, token: string): Promise<void> {
  await store.transaction((state) => ({
    state: {
      ...state,
      sessions: state.sessions.map((session) => session.tokenHash === hash(token) ? { ...session, revokedAt: new Date().toISOString(), version: session.version + 1 } : session)
    },
    result: undefined
  }));
}

/**
 * Expiry the snapshot alone can decide: revocation and the absolute lifetime.
 * The idle window is evaluated separately against session activity, because
 * recording liveness in the snapshot would turn every authenticated read into a
 * global write on the single locked JSONB row.
 */
export function sessionTerminallyExpired(session: { expiresAt: string; revokedAt?: string }): boolean {
  return Boolean(session.revokedAt) || Date.parse(session.expiresAt) <= Date.now();
}

/**
 * Idle evaluation and liveness recording, both outside the snapshot.
 *
 * The read is one indexed row and the write a single-row UPSERT, so an
 * authenticated request no longer competes with clinical writes for the global
 * state lock. A session with no activity row predates the table (the 012
 * migration seeds one idle window for those) or was pruned by retention; either
 * way the creation time is the conservative reference.
 */
async function assertSessionIsActive(store: StateStore, session: StoreState["sessions"][number]): Promise<void> {
  const nowMs = Date.now();
  const activity = await store.readSessionActivity(session.id);
  const referenceAt = activity?.lastSeenAt ?? session.createdAt;
  // A missing or unparsable reference fails closed: an unreadable liveness
  // record must not become an indefinite session.
  if (!Number.isFinite(Date.parse(referenceAt)) || sessionIsIdle(referenceAt, nowMs)) {
    throw new ApiError("SESSION_EXPIRED", "Sessão expirada por inatividade. Entre novamente.", 401);
  }
  if (!shouldTouchSessionActivity(activity, session.createdAt, nowMs, sessionActivityTouchIntervalMs())) return;
  await store.touchSessionActivity({
    sessionId: session.id,
    userId: session.userId,
    lastSeenAt: new Date(nowMs).toISOString()
  });
}

function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const tokenHash = Buffer.from(hash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return tokenHash.length === expected.length && timingSafeEqual(tokenHash, expected);
}

function assertCsrf(request: Request, expectedTokenHash: string): void {
  const cookies = parseCookies(request);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken) {
    throw new ApiError("CSRF_INVALID", "A confirmação de segurança da sessão é inválida.", 403);
  }
  const cookieIsBoundToSession = tokenMatchesHash(cookieToken, expectedTokenHash);
  const headerIsBoundToSession = tokenMatchesHash(headerToken, expectedTokenHash);
  if (!cookieIsBoundToSession || !headerIsBoundToSession) {
    throw new ApiError("CSRF_INVALID", "A confirmação de segurança da sessão é inválida.", 403);
  }
}

export function serializeCookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; expires?: string } = {}): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    process.env.NODE_ENV === "production" ? "Secure" : "",
    options.httpOnly ? "HttpOnly" : "",
    options.maxAge !== undefined ? `Max-Age=${options.maxAge}` : "",
    options.expires ? `Expires=${options.expires}` : ""
  ].filter(Boolean);
  return attributes.join("; ");
}

export function clearSessionCookies(): string[] {
  return [serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }), serializeCookie(CSRF_COOKIE, "", { maxAge: 0 })];
}

export function sessionCookies(login: { sessionToken: string; csrfToken: string; expiresAt: string }): string[] {
  const maxAge = Math.floor((new Date(login.expiresAt).getTime() - Date.now()) / 1000);
  return [serializeCookie(SESSION_COOKIE, login.sessionToken, { httpOnly: true, maxAge }), serializeCookie(CSRF_COOKIE, login.csrfToken, { maxAge })];
}

export function getCookieValue(request: Request, name: string): string | undefined {
  return parseCookies(request)[name];
}
