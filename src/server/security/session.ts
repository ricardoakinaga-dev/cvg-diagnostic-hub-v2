import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StateStore, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { verifyPassword } from "./password";

const SESSION_COOKIE = "cvg_session";
const CSRF_COOKIE = "cvg_csrf";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getCsrfCookieName(): string {
  return CSRF_COOKIE;
}

export async function loginUser(store: StateStore, email: string, password: string) {
  return store.transaction(async (state) => {
    const user = state.users.find((candidate) => candidate.email.toLowerCase() === email.trim().toLowerCase() && candidate.active);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new ApiError("UNAUTHENTICATED", "Credenciais inválidas.", 401);
    }
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
      state: { ...state, sessions: [...state.sessions, session] },
      result: { user, sessionToken, csrfToken, expiresAt }
    };
  });
}

export async function authenticateRequest(
  store: StateStore,
  request: Request,
  options: { requireCsrf?: boolean } = {}
): Promise<User> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) throw new ApiError("UNAUTHENTICATED", "Sessão necessária.", 401);
  const state = await store.readState();
  const session = state.sessions.find((entry) => entry.tokenHash === hash(token));
  if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
  }
  if (options.requireCsrf) assertCsrf(request, session.csrfTokenHash);
  const user = state.users.find((entry) => entry.id === session.userId && entry.active);
  if (!user) throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
  return { ...user, sessionId: session.id, reauthenticatedAt: session.reauthenticatedAt };
}

export function authorizationSnapshotIsCurrent(state: StoreState, actor: User): boolean {
  const current = state.users.find((user) => user.id === actor.id);
  const session = actor.sessionId ? state.sessions.find((entry) => entry.id === actor.sessionId && entry.userId === actor.id) : undefined;
  return Boolean(
    current?.active
    && current.version === actor.version
    && current.role === actor.role
    && current.departmentCode === actor.departmentCode
    && sameScope(current.patientIds, actor.patientIds)
    && sameScope(current.serviceCodes, actor.serviceCodes)
    && sameScope(current.managedDepartmentCodes, actor.managedDepartmentCodes)
    && session
    && !session.revokedAt
    && new Date(session.expiresAt).getTime() > Date.now()
  );
}

export async function reauthenticateUser(store: StateStore, request: Request, password: string): Promise<User> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) throw new ApiError("UNAUTHENTICATED", "Sessão necessária.", 401);
  return store.transaction((state) => {
    const session = state.sessions.find((entry) => entry.tokenHash === hash(token));
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401);
    }
    const user = state.users.find((entry) => entry.id === session.userId && entry.active);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new ApiError("UNAUTHENTICATED", "Credenciais inválidas.", 401);
    }
    const reauthenticatedAt = new Date().toISOString();
    const updatedSession = { ...session, reauthenticatedAt, version: session.version + 1 };
    return {
      state: { ...state, sessions: state.sessions.map((entry) => entry.id === session.id ? updatedSession : entry) },
      result: { ...user, sessionId: session.id, reauthenticatedAt }
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
