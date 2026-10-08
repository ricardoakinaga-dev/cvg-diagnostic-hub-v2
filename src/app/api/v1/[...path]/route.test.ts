import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./route";
import { getRuntimeStoreAsync, resetRuntimeStore } from "../../../../server/store/runtime";
import { renderPrometheus, resetMetrics } from "../../../../server/observability/metrics";
import { resetRateLimits } from "../../../../server/security/rate-limit";
import * as rateLimitSecurity from "../../../../server/security/rate-limit";
import { ApiError } from "../../../../server/http/envelope";
import { syntheticHemogramContent } from "../../../../server/store/fixtures";
import * as structuredLogger from "../../../../server/observability/structured-logger";

process.env.APP_DATA_MODE = "memory";
process.env.DEMO_PASSWORD = "api-test-password";
process.env.LOGIN_RATE_LIMIT = "100";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function login(email = "vet@cvg.local") {
  const response = await POST(new Request("http://localhost/api/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "api-test-password" })
  }), params(["session", "login"]));
  const setCookie = response.headers.get("set-cookie") ?? "";
  const session = setCookie.match(/cvg_session=([^;]+)/)?.[1];
  const csrf = setCookie.match(/cvg_csrf=([^;]+)/)?.[1];
  if (!session || !csrf) throw new Error("session cookies missing");
  return { cookie: `cvg_session=${session}; cvg_csrf=${csrf}`, csrf };
}

describe("versioned API boundary", () => {
  beforeEach(() => {
    resetRuntimeStore();
    resetMetrics();
    resetRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes liveness with correlation metadata without authentication", async () => {
    const response = await GET(new Request("http://localhost/api/v1/livez"), params(["livez"]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body).not.toHaveProperty("success");
    expect(body.meta).toMatchObject({ requestId: expect.any(String), correlationId: expect.any(String) });
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("rejects trailing segments and undeclared methods before catch-all dispatch", async () => {
    const trailing = await GET(
      new Request("http://localhost/api/v1/livez/unexpected"),
      params(["livez", "unexpected"])
    );
    const wrongMethod = await PUT(
      new Request("http://localhost/api/v1/livez", { method: "PUT" }),
      params(["livez"])
    );
    const overlongDynamicSegment = await GET(
      new Request(`http://localhost/api/v1/patients/${"x".repeat(101)}`),
      params(["patients", "x".repeat(101)])
    );
    const percentPathSegment = await GET(
      new Request("http://localhost/api/v1/patients/%25"),
      params(["patients", "%"])
    );

    expect(trailing.status).toBe(404);
    expect((await trailing.json()).error.code).toBe("NOT_FOUND");
    expect(wrongMethod.status).toBe(404);
    expect((await wrongMethod.json()).error.code).toBe("NOT_FOUND");
    expect(overlongDynamicSegment.status).toBe(404);
    expect((await overlongDynamicSegment.json()).error.code).toBe("NOT_FOUND");
    expect(percentPathSegment.status).toBe(404);
    expect((await percentPathSegment.json()).error.code).toBe("NOT_FOUND");
  });

  it("applies the JSON byte boundary to public and authenticated parsers", async () => {
    const auth = await login();
    process.env.JSON_BODY_MAX_BYTES = "256";
    try {
      const oversizedLogin = await POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${" ".repeat(300)}${JSON.stringify({ email: "vet@cvg.local", password: "api-test-password" })}`
      }), params(["session", "login"]));
      const oversizedCommand = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
          "idempotency-key": "oversized-json-command"
        },
        body: `${" ".repeat(300)}${JSON.stringify({
          patientId: "patient-thor",
          encounterId: "encounter-thor",
          priority: "ROUTINE",
          items: [{ serviceId: "service-hemogram" }]
        })}`
      }), params(["diagnostic-requests"]));

      expect(oversizedLogin.status).toBe(400);
      expect((await oversizedLogin.json()).error.code).toBe("VALIDATION_ERROR");
      expect(oversizedCommand.status).toBe(400);
      expect((await oversizedCommand.json()).error.code).toBe("VALIDATION_ERROR");
    } finally {
      delete process.env.JSON_BODY_MAX_BYTES;
    }
  });

  it("rejects malformed optional headers declared by the operation contract", async () => {
    const invalidCorrelation = await GET(new Request("http://localhost/api/v1/livez", {
      headers: { "x-correlation-id": "contains spaces" }
    }), params(["livez"]));
    expect(invalidCorrelation.status).toBe(400);
    expect((await invalidCorrelation.json()).error.code).toBe("VALIDATION_ERROR");

    const auth = await login();
    const oversizedReplayId = await GET(new Request("http://localhost/api/v1/realtime/events?snapshot=true", {
      headers: { cookie: auth.cookie, "last-event-id": "x".repeat(201) }
    }), params(["realtime", "events"]));
    expect(oversizedReplayId.status).toBe(400);
    expect((await oversizedReplayId.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects JSON sent with an unsupported media type", async () => {
    const response = await POST(new Request("http://localhost/api/v1/session/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ email: "vet@cvg.local", password: "api-test-password" })
    }), params(["session", "login"]));

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("enforces route-level nesting and binary media boundaries", async () => {
    const auth = await login();
    process.env.JSON_BODY_MAX_DEPTH = "3";
    try {
      const nested = await POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "vet@cvg.local", password: "api-test-password", nested: { a: { b: { c: true } } } })
      }), params(["session", "login"]));
      expect(nested.status).toBe(400);
      expect((await nested.json()).error.code).toBe("VALIDATION_ERROR");

      const binary = await PUT(new Request("http://localhost/api/v1/attachments/attachment-missing/content", {
        method: "PUT",
        headers: { "content-type": "text/plain", cookie: auth.cookie, "x-csrf-token": auth.csrf },
        body: "not an octet stream"
      }), params(["attachments", "attachment-missing", "content"]));
      expect(binary.status).toBe(415);
      expect((await binary.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    } finally {
      delete process.env.JSON_BODY_MAX_DEPTH;
    }
  });

  it("reports readiness only after the configured store is available", async () => {
    const response = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "ready", dataMode: "memory" });
  });

  it("logs unexpected dependency failures with a safe code and keeps the client response generic", async () => {
    const admin = await login("admin@cvg.local");
    const store = await getRuntimeStoreAsync();
    const failure = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: failure
    });
    vi.spyOn(store, "readState").mockRejectedValue(new Error("clinical payload and stack must stay server-side"));
    const correlationId = "corr_123e4567-e89b-12d3-a456-426614174000";

    const response = await GET(new Request("http://localhost/api/v1/metrics", {
      headers: { cookie: admin.cookie, "x-correlation-id": correlationId }
    }), params(["metrics"]));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatchObject({ code: "INTERNAL_ERROR", correlationId });
    expect(body.error).not.toHaveProperty("stack");
    expect(JSON.stringify(body)).not.toContain("clinical payload");
    expect(failure).toHaveBeenCalledWith("http.failure", {
      component: "http",
      requestId: expect.stringMatching(/^req_/),
      correlationId,
      errorCode: "INTERNAL",
      status: 500
    });
  });

  it("isolates health budgets from each other and from authenticated traffic", async () => {
    vi.stubEnv("HEALTH_RATE_LIMIT", "1");
    resetRateLimits();
    try {
      const firstLiveness = await GET(new Request("http://localhost/api/v1/livez"), params(["livez"]));
      const secondLiveness = await GET(new Request("http://localhost/api/v1/livez"), params(["livez"]));
      const readiness = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));
      const auth = await login();
      const session = await GET(new Request("http://localhost/api/v1/session/me", { headers: { cookie: auth.cookie } }), params(["session", "me"]));

      expect(firstLiveness.status).toBe(200);
      expect(secondLiveness.status).toBe(429);
      expect(readiness.status).toBe(200);
      expect(session.status).toBe(200);
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("fails readiness closed when distributed rate limiting lacks its shared backend", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "");
    try {
      const response = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toMatchObject({ code: "NOT_READY" });
      expect(JSON.stringify(body)).not.toContain("postgresql://");
    } finally {
      vi.unstubAllEnvs();
      resetRuntimeStore();
    }
  });

  it("rate limits unauthenticated protected traffic before session lookup", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("UNAUTHENTICATED_RATE_LIMIT", "1");
    resetRateLimits();
    try {
      const first = await GET(new Request("http://localhost/api/v1/diagnostic-services"), params(["diagnostic-services"]));
      const second = await GET(new Request("http://localhost/api/v1/diagnostic-services"), params(["diagnostic-services"]));

      expect(first.status).toBe(401);
      expect(second.status).toBe(429);
      expect((await second.json()).error.code).toBe("RATE_LIMITED");
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("fails closed before touching runtime dependencies when production proxy identity is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", undefined);
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", undefined);
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    try {
      const response = await GET(new Request("http://localhost/api/v1/diagnostic-services"), params(["diagnostic-services"]));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error.code).toBe("RATE_LIMIT_UNAVAILABLE");
      expect(globalThis.__cvgDiagnosticsStore).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      resetRuntimeStore();
    }
  });

  it("consumes the readiness budget before a failing dependency probe", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("HEALTH_RATE_LIMIT", "1");
    vi.stubEnv("STORAGE_MODE", "s3");
    vi.stubEnv("STORAGE_ENDPOINT", undefined);
    resetRateLimits();
    try {
      const first = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));
      const second = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));

      expect(first.status).toBe(503);
      expect(second.status).toBe(429);
    } finally {
      vi.unstubAllEnvs();
      resetRateLimits();
      resetRuntimeStore();
    }
  });

  it("gives the shared client address a larger login budget than one account, so a shift change behind NAT is not locked out", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "proxy-secret");
    vi.stubEnv("LOGIN_RATE_LIMIT", "2");
    resetRateLimits();
    const login = (email: string) => POST(new Request("http://localhost/api/v1/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.40", "x-cvg-proxy-secret": "proxy-secret" },
      body: JSON.stringify({ email, password: "wrong-password-for-budget" })
    }), params(["session", "login"]));
    try {
      // Five staff members behind one address each fail once: none is throttled by the address.
      for (const email of ["vet@cvg.local", "lab@cvg.local", "rx@cvg.local", "us@cvg.local", "manager@cvg.local"]) {
        expect((await login(email)).status).toBe(401);
      }
      // One account guessing repeatedly still meets its own budget.
      expect((await login("vet@cvg.local")).status).toBe(401);
      expect((await login("vet@cvg.local")).status).toBe(429);
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("keeps forwarded headers from changing rate-limit identity without the trusted proxy secret", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "proxy-secret");
    vi.stubEnv("LOGIN_RATE_LIMIT", "1");
    vi.stubEnv("LOGIN_CLIENT_RATE_LIMIT", "1");
    resetRateLimits();

    const malformedLogin = (headers: Record<string, string>) => POST(new Request("http://localhost/api/v1/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{"
    }), params(["session", "login"]));

    try {
      const trustedFirst = await malformedLogin({ "x-forwarded-for": "198.51.100.10", "x-cvg-proxy-secret": "proxy-secret" });
      const trustedSecond = await malformedLogin({ "x-forwarded-for": "198.51.100.10", "x-cvg-proxy-secret": "proxy-secret" });
      const trustedOther = await malformedLogin({ "x-forwarded-for": "198.51.100.11", "x-cvg-proxy-secret": "proxy-secret" });
      const forgedFirst = await malformedLogin({ "x-forwarded-for": "203.0.113.10", "x-cvg-proxy-secret": "wrong-secret" });
      const forgedSecond = await malformedLogin({ "x-forwarded-for": "203.0.113.11", "x-cvg-proxy-secret": "wrong-secret" });

      expect(trustedFirst.status).toBe(400);
      expect(trustedSecond.status).toBe(429);
      expect(trustedOther.status).toBe(400);
      expect(forgedFirst.status).toBe(400);
      expect(forgedSecond.status).toBe(400);
      expect((await forgedSecond.json()).error.code).toBe("VALIDATION_ERROR");
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("keeps login budgets independent per email when the client identity is unavailable", async () => {
    vi.stubEnv("LOGIN_RATE_LIMIT", "1");
    vi.stubEnv("TRUST_PROXY", undefined);
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", undefined);
    resetRateLimits();
    try {
      const vet = await login("vet@cvg.local");
      const admin = await login("admin@cvg.local");

      expect(vet.cookie).toContain("cvg_session=");
      expect(admin.cookie).toContain("cvg_session=");
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("does not let an attacker spend the victim's login budget from another origin", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "proxy-secret");
    vi.stubEnv("LOGIN_RATE_LIMIT", "3");
    resetRateLimits();
    try {
      const loginAs = (email: string, forwardedFor: string, password = "api-test-password") => POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
          "x-cvg-proxy-secret": "proxy-secret"
        },
        body: JSON.stringify({ email, password })
      }), params(["session", "login"]));

      // The attacker burns the whole budget for (vet@cvg.local, 198.51.100.7)
      // with wrong passwords only.
      const attackerStatuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        attackerStatuses.push((await loginAs("vet@cvg.local", "198.51.100.7", "wrong-password")).status);
      }
      expect(attackerStatuses).toContain(401);
      expect(attackerStatuses).toContain(429);

      // The owner arriving from their own origin with the right password is
      // still served: the account-wide lockout of F-04 is gone.
      const owner = await loginAs("vet@cvg.local", "203.0.113.9");
      expect(owner.status).toBe(200);
      expect((await owner.json()).data.user.email).toBe("vet@cvg.local");

      // And the attacker's own pair is still throttled.
      expect((await loginAs("vet@cvg.local", "198.51.100.7")).status).toBe(429);
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("clears the login backoff after a successful login", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("LOGIN_RATE_LIMIT", "20");
    resetRateLimits();
    try {
      const attempt = (password: string) => POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "vet@cvg.local", password })
      }), params(["session", "login"]));

      for (let index = 0; index < 6; index += 1) {
        expect((await attempt("wrong-password")).status).toBe(401);
      }

      // Six wrong passwords grew the window for this pair, and a correct
      // password still succeeds and clears this pair’s backoff.
      expect((await attempt("api-test-password")).status).toBe(200);
      expect((await attempt("api-test-password")).status).toBe(200);
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("returns a dependency error without a session when the successful-login reset fails", async () => {
    const store = await getRuntimeStoreAsync();
    const before = await store.readStateSnapshot();
    const reset = vi.spyOn(rateLimitSecurity, "registerLoginSuccess").mockRejectedValueOnce(
      new ApiError("DEPENDENCY_UNAVAILABLE", "O controle de abuso não está disponível.", 503)
    );
    try {
      const response = await POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "vet@cvg.local", password: "api-test-password" })
      }), params(["session", "login"]));
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await store.readStateSnapshot()).toEqual(before);
      expect(reset).toHaveBeenCalledWith({ email: "vet@cvg.local", clientKey: "local" });
    } finally {
      reset.mockRestore();
    }
  });

  it("does not count a correct password as a failure when user revalidation races", async () => {
    const store = await getRuntimeStoreAsync();
    const before = await store.readStateSnapshot();
    const transaction = store.transaction.bind(store);
    const race = vi.spyOn(store, "transaction").mockImplementation((operation) => transaction((state) => operation({
      ...state,
      users: state.users.map((user) => user.email === "vet@cvg.local" ? { ...user, version: user.version + 1 } : user)
    })));
    const failure = vi.spyOn(rateLimitSecurity, "registerLoginFailure");
    try {
      const response = await POST(new Request("http://localhost/api/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "vet@cvg.local", password: "api-test-password" })
      }), params(["session", "login"]));
      expect(response.status).toBe(401);
      expect(failure).not.toHaveBeenCalled();
      expect(await store.readStateSnapshot()).toEqual(before);
    } finally {
      race.mockRestore();
      failure.mockRestore();
    }
  });

  it("keeps authenticated budgets independent per session", async () => {
    vi.stubEnv("AUTHENTICATED_RATE_LIMIT", "1");
    resetRateLimits();
    try {
      const vet = await login("vet@cvg.local");
      const admin = await login("admin@cvg.local");
      const vetFirst = await GET(new Request("http://localhost/api/v1/session/me", { headers: { cookie: vet.cookie } }), params(["session", "me"]));
      const vetSecond = await GET(new Request("http://localhost/api/v1/session/me", { headers: { cookie: vet.cookie } }), params(["session", "me"]));
      const adminFirst = await GET(new Request("http://localhost/api/v1/session/me", { headers: { cookie: admin.cookie } }), params(["session", "me"]));

      expect(vetFirst.status).toBe(200);
      expect(vetSecond.status).toBe(429);
      expect(adminFirst.status).toBe(200);
    } finally {
      resetRateLimits();
      vi.unstubAllEnvs();
    }
  });

  it("reports storage readiness failure and exposes the failure counter only to an administrator", async () => {
    process.env.STORAGE_MODE = "s3";
    delete process.env.STORAGE_ENDPOINT;
    try {
      const response = await GET(new Request("http://localhost/api/v1/readyz"), params(["readyz"]));
      expect(response.status).toBe(503);

      delete process.env.STORAGE_MODE;
      const admin = await login("admin@cvg.local");
      const metrics = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
      expect(await metrics.text()).toContain("cvg_readiness_failures 1");
    } finally {
      delete process.env.STORAGE_MODE;
      delete process.env.STORAGE_ENDPOINT;
      resetRuntimeStore();
    }
  });

  it("rejects protected resources when no session exists", async () => {
    const response = await GET(new Request("http://localhost/api/v1/diagnostic-services"), params(["diagnostic-services"]));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("treats a malformed session cookie as an unauthenticated request", async () => {
    const response = await GET(new Request("http://localhost/api/v1/session/me", {
      headers: { cookie: "cvg_session=%E0%A4%A" }
    }), params(["session", "me"]));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Sessão necessária." });
  });

  it("returns the same generic login error for an unknown user", async () => {
    const response = await POST(new Request("http://localhost/api/v1/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@cvg.local", password: "wrong-password" })
    }), params(["session", "login"]));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Credenciais inválidas." });
    expect(JSON.stringify(body)).not.toContain("missing@cvg.local");
  });

  it("rejects a mutation when matching CSRF cookie and header tokens belong to another session", async () => {
    const authenticatedSession = await login();
    const otherSession = await login("admin@cvg.local");
    const sessionToken = authenticatedSession.cookie.match(/cvg_session=([^;]+)/)?.[1];
    if (!sessionToken) throw new Error("session cookie missing");

    const response = await POST(new Request("http://localhost/api/v1/session/logout", {
      method: "POST",
      headers: {
        cookie: `cvg_session=${sessionToken}; cvg_csrf=${otherSession.csrf}`,
        "x-csrf-token": otherSession.csrf
      }
    }), params(["session", "logout"]));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CSRF_INVALID");
    const stillAuthenticated = await GET(new Request("http://localhost/api/v1/session/me", {
      headers: { cookie: authenticatedSession.cookie }
    }), params(["session", "me"]));
    expect(stillAuthenticated.status).toBe(200);
  });

  it("exposes versioned administration reads only to configuration actors", async () => {
    const admin = await login("admin@cvg.local");
    const services = await GET(new Request("http://localhost/api/v1/diagnostic-services?includeInactive=true", { headers: { cookie: admin.cookie } }), params(["diagnostic-services"]));
    expect(services.status).toBe(200);
    expect((await services.json()).data[0]).toMatchObject({ code: "HEMOGRAM", active: true, version: 1 });

    const lab = await login("lab@cvg.local");
    const template = await GET(new Request("http://localhost/api/v1/diagnostic-services/service-hemogram/result-template", { headers: { cookie: lab.cookie } }), params(["diagnostic-services", "service-hemogram", "result-template"]));
    expect(template.status).toBe(200);
    expect((await template.json()).data).toMatchObject({ kind: "LABORATORY_PANEL", code: "SYNTHETIC_HEMOGRAM", version: 1 });
    const crossDepartment = await GET(new Request("http://localhost/api/v1/diagnostic-services/service-xray/result-template", { headers: { cookie: lab.cookie } }), params(["diagnostic-services", "service-xray", "result-template"]));
    expect(crossDepartment.status).toBe(404);

    const reasons = await GET(new Request("http://localhost/api/v1/reason-codes", { headers: { cookie: admin.cookie } }), params(["reason-codes"]));
    expect(reasons.status).toBe(200);
    expect((await reasons.json()).data.map((entry: { code: string }) => entry.code)).toContain("HEMOLYZED");

    const vet = await login();
    const denied = await GET(new Request("http://localhost/api/v1/diagnostic-services?includeInactive=true", { headers: { cookie: vet.cookie } }), params(["diagnostic-services"]));
    expect(denied.status).toBe(404);

    const invalid = await GET(new Request("http://localhost/api/v1/diagnostic-services?includeInactive=not-a-boolean", { headers: { cookie: admin.cookie } }), params(["diagnostic-services"]));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("supports audited role administration without exposing password hashes", async () => {
    const admin = await login("admin@cvg.local");
    const users = await GET(new Request("http://localhost/api/v1/users", { headers: { cookie: admin.cookie } }), params(["users"]));
    expect(users.status).toBe(200);
    const usersBody = await users.json();
    expect(usersBody.data.find((user: { email: string }) => user.email === "vet@cvg.local")).toMatchObject({ createdAt: expect.any(String), timezone: "America/Sao_Paulo" });
    expect(usersBody.data.find((user: { email: string }) => user.email === "vet@cvg.local")).not.toHaveProperty("passwordHash");

    const reauth = await POST(new Request("http://localhost/api/v1/session/reauth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ password: "api-test-password" })
    }), params(["session", "reauth"]));
    expect(reauth.status).toBe(200);

    const updated = await POST(new Request("http://localhost/api/v1/users/user-vet/roles", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf, "idempotency-key": "api-role-update" },
      body: JSON.stringify({ role: "MANAGER", departmentCode: "INPATIENT", active: true, expectedVersion: 1, reason: "Atualizar acesso operacional", confirm: true })
    }), params(["users", "user-vet", "roles"]));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ role: "MANAGER", version: 2 });

    const lab = await login("lab@cvg.local");
    const denied = await GET(new Request("http://localhost/api/v1/users", { headers: { cookie: lab.cookie } }), params(["users"]));
    expect(denied.status).toBe(404);
  });

  it("exposes scoped session revocation and an audited dead-letter control surface", async () => {
    const admin = await login("admin@cvg.local");
    const vet = await login("vet@cvg.local");
    const sessionsResponse = await GET(new Request("http://localhost/api/v1/sessions", { headers: { cookie: admin.cookie } }), params(["sessions"]));
    expect(sessionsResponse.status).toBe(200);
    const sessionsBody = await sessionsResponse.json();
    const targetSession = sessionsBody.data.find((session: { userEmail: string }) => session.userEmail === "vet@cvg.local");
    expect(targetSession).toMatchObject({ status: "ACTIVE", current: false });
    expect(targetSession).not.toHaveProperty("tokenHash");

    const reauth = await POST(new Request("http://localhost/api/v1/session/reauth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ password: "api-test-password" })
    }), params(["session", "reauth"]));
    expect(reauth.status).toBe(200);

    const revoked = await POST(new Request(`http://localhost/api/v1/sessions/${targetSession.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf, "idempotency-key": "api-session-revoke" },
      body: JSON.stringify({ reason: "Encerramento operacional", confirm: true })
    }), params(["sessions", targetSession.id, "revoke"]));
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data).toMatchObject({ id: targetSession.id, status: "REVOKED" });
    expect((await GET(new Request("http://localhost/api/v1/session/me", { headers: { cookie: vet.cookie } }), params(["session", "me"]))).status).toBe(401);

    const store = await getRuntimeStoreAsync();
    await store.transaction((state) => ({
      state: {
        ...state,
        outbox: [...state.outbox, {
          id: "api-dead-letter",
          eventType: "UnsupportedEvent",
          aggregateType: "DiagnosticRequest",
          aggregateId: "request-1",
          payload: { requestId: "request-1" },
          consumerType: "DOMAIN_EVENT",
          routingKey: "domain.UnsupportedEvent",
          status: "FAILED" as const,
          attempts: 5,
          availableAt: "2026-08-20T10:00:00.000Z",
          correlationId: "corr-api-dead-letter",
          lastError: "sink unavailable",
          deadLetteredAt: "2026-08-20T10:00:00.000Z"
        }]
      },
      result: undefined
    }));

    const deadLetters = await GET(new Request("http://localhost/api/v1/outbox/dead-letters", { headers: { cookie: admin.cookie } }), params(["outbox", "dead-letters"]));
    expect(deadLetters.status).toBe(200);
    expect((await deadLetters.json()).data).toMatchObject([{ id: "api-dead-letter", status: "FAILED" }]);

    const reauthAgain = await POST(new Request("http://localhost/api/v1/session/reauth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ password: "api-test-password" })
    }), params(["session", "reauth"]));
    expect(reauthAgain.status).toBe(200);
    const discarded = await POST(new Request("http://localhost/api/v1/outbox/dead-letters/api-dead-letter/discard", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf, "idempotency-key": "api-dead-letter-discard" },
      body: JSON.stringify({ reason: "Evento inválido para entrega", confirm: true })
    }), params(["outbox", "dead-letters", "api-dead-letter", "discard"]));
    expect(discarded.status).toBe(200);
    expect((await discarded.json()).data).toMatchObject({ action: "DISCARDED", message: { status: "DISCARDED" } });
  });

  it("supports delegated collaborator creation, operational overview and soft deactivation", async () => {
    const manager = await login("manager@cvg.local");
    const reauth = await POST(new Request("http://localhost/api/v1/session/reauth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf },
      body: JSON.stringify({ password: "api-test-password" })
    }), params(["session", "reauth"]));
    expect(reauth.status).toBe(200);

    const created = await POST(new Request("http://localhost/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-create-user" },
      body: JSON.stringify({ email: "api-created-lab@cvg.local", displayName: "Colaborador API", password: "api-created-password-123", role: "LAB_TECH", departmentCode: "LABORATORY", timezone: "America/Sao_Paulo", reason: "Cobertura de laboratório", confirm: true })
    }), params(["users"]));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.data).toMatchObject({ email: "api-created-lab@cvg.local", active: true });
    expect(createdBody.data).not.toHaveProperty("passwordHash");

    const overview = await GET(new Request("http://localhost/api/v1/management/overview", { headers: { cookie: manager.cookie } }), params(["management", "overview"]));
    expect(overview.status).toBe(200);
    expect((await overview.json()).data).toMatchObject({ summary: expect.any(Object), departments: expect.any(Array), pending: expect.any(Array) });

    const deactivated = await DELETE(new Request(`http://localhost/api/v1/users/${createdBody.data.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-deactivate-user" },
      body: JSON.stringify({ expectedVersion: createdBody.data.version, reason: "Fim do acesso API", confirm: true })
    }), params(["users", createdBody.data.id]));
    expect(deactivated.status).toBe(200);
    expect((await deactivated.json()).data).toMatchObject({ id: createdBody.data.id, active: false });
  });

  it("accepts full catalog customization and rejects malformed structural data at the API boundary", async () => {
    const manager = await login("manager@cvg.local");
    const blankName = await POST(new Request("http://localhost/api/v1/diagnostic-services", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-blank-service" },
      body: JSON.stringify({ code: "API_BLANK_SERVICE", name: " ", category: "IMAGING", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", requiresSample: false, requiresSchedule: true, allowsAttachment: true, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 48, URGENT: 12, EMERGENCY: 4 } })
    }), params(["diagnostic-services"]));
    expect(blankName.status).toBe(400);
    expect((await blankName.json()).error.code).toBe("VALIDATION_ERROR");

    const created = await POST(new Request("http://localhost/api/v1/diagnostic-services", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-create-service" },
      body: JSON.stringify({ code: "API_CUSTOM_SERVICE", name: "Serviço configurável", category: "IMAGING", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", requiresSample: false, requiresSchedule: true, allowsAttachment: true, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 48, URGENT: 12, EMERGENCY: 4 } })
    }), params(["diagnostic-services"]));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const incompatiblePatch = await PATCH(new Request(`http://localhost/api/v1/diagnostic-services/${createdBody.data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-incompatible-service" },
      body: JSON.stringify({ category: "LABORATORY", workflowType: "RADIOLOGY", expectedVersion: createdBody.data.version })
    }), params(["diagnostic-services", createdBody.data.id]));
    expect(incompatiblePatch.status).toBe(400);
    expect((await incompatiblePatch.json()).error.code).toBe("VALIDATION_ERROR");

    const updated = await PATCH(new Request(`http://localhost/api/v1/diagnostic-services/${createdBody.data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: manager.cookie, "x-csrf-token": manager.csrf, "idempotency-key": "api-manager-update-service" },
      body: JSON.stringify({ name: "Serviço configurável revisado", category: "IMAGING", departmentCode: "ULTRASOUND", workflowType: "ULTRASOUND", requiresSample: false, requiresSchedule: true, allowsAttachment: true, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 72, URGENT: 18, EMERGENCY: 6 }, expectedVersion: createdBody.data.version })
    }), params(["diagnostic-services", createdBody.data.id]));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ name: "Serviço configurável revisado", departmentCode: "ULTRASOUND", workflowType: "ULTRASOUND" });
  });

  it("creates a request through the authenticated HTTP boundary", async () => {
    const auth = await login();
    const response = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "idempotency-key": "api-request-1"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "URGENT",
        items: [{ serviceId: "service-hemogram" }]
      })
    }), params(["diagnostic-requests"]));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.requestCode).toMatch(/^EX-/);
    expect(body.data.items[0].service.code).toBe("HEMOGRAM");

    const itemResponse = await GET(new Request(`http://localhost/api/v1/diagnostic-items/${body.data.items[0].id}`, { headers: { cookie: auth.cookie } }), params(["diagnostic-items", body.data.items[0].id]));
    expect(itemResponse.status).toBe(200);
    expect((await itemResponse.json()).data.service.code).toBe("HEMOGRAM");

    const realtimeResponse = await GET(new Request("http://localhost/api/v1/realtime/events?snapshot=true", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
    const realtimeBody = await realtimeResponse.text();
    expect(realtimeResponse.status).toBe(200);
    expect(realtimeBody).toContain("retry: 5000");
    expect(realtimeBody).toContain("event: diagnostic.updated");
    const eventId = realtimeBody.match(/id: ([^\n]+)/)?.[1];
    expect(eventId).toBeTruthy();

    const replay = await GET(new Request("http://localhost/api/v1/realtime/events?snapshot=true", { headers: { cookie: auth.cookie, "last-event-id": eventId! } }), params(["realtime", "events"]));
    expect(await replay.text()).not.toContain(`id: ${eventId}`);

    const resync = await GET(new Request("http://localhost/api/v1/realtime/events?snapshot=true", { headers: { cookie: auth.cookie, "last-event-id": "expired-event" } }), params(["realtime", "events"]));
    expect(await resync.text()).toContain("event: resync_required");
  });

  it("registers a patient and its initial encounter through the authenticated HTTP boundary", async () => {
    const auth = await login();
    const payload = {
      displayName: "Amora API",
      species: "Canino",
      breed: "Border Collie",
      sex: "Fêmea",
      ownerLabel: "M. Ribeiro",
      externalId: "HIS-AMORA-API",
      encounterType: "OUTPATIENT"
    };
    const response = await POST(new Request("http://localhost/api/v1/patients", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "api-patient-create" },
      body: JSON.stringify(payload)
    }), params(["patients"]));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.patient).toMatchObject({ displayName: "Amora API", externalId: "HIS-AMORA-API", active: true });
    expect(body.data.encounter).toMatchObject({ patientId: body.data.patient.id, type: "OUTPATIENT", status: "OPEN" });

    const patients = await GET(new Request("http://localhost/api/v1/patients?q=Amora%20API", { headers: { cookie: auth.cookie } }), params(["patients"]));
    expect(patients.status).toBe(200);
    expect((await patients.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: body.data.patient.id, externalId: "HIS-AMORA-API" })]));

    const encounters = await GET(new Request(`http://localhost/api/v1/patients/${body.data.patient.id}/encounters`, { headers: { cookie: auth.cookie } }), params(["patients", body.data.patient.id, "encounters"]));
    expect(encounters.status).toBe(200);
    expect((await encounters.json()).data).toEqual([expect.objectContaining({ id: body.data.encounter.id, patientId: body.data.patient.id })]);
  });

  it("rejects missing, malformed, or conflicting optimistic concurrency guards before mutation", async () => {
    const auth = await login();
    const created = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "api-concurrency-request" },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
    }), params(["diagnostic-requests"]));
    const request = (await created.json()).data;

    const cancel = (key: string, headers: Record<string, string>, body: Record<string, unknown> = { reasonCode: "CLINICAL_DECISION" }) => POST(
      new Request(`http://localhost/api/v1/diagnostic-requests/${request.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": key, ...headers },
        body: JSON.stringify(body)
      }),
      params(["diagnostic-requests", request.id, "cancel"])
    );

    expect((await cancel("api-concurrency-malformed", { "if-match": "definitely-invalid" })).status).toBe(400);
    expect((await cancel("api-concurrency-conflict", { "if-match": "2" }, { reasonCode: "CLINICAL_DECISION", expectedVersion: 1 })).status).toBe(400);
    expect((await cancel("api-concurrency-missing", {})).status).toBe(400);

    const unchanged = await GET(new Request(`http://localhost/api/v1/diagnostic-requests/${request.id}`, { headers: { cookie: auth.cookie } }), params(["diagnostic-requests", request.id]));
    expect((await unchanged.json()).data).toMatchObject({ version: 1, aggregateStatus: "REQUESTED" });

    const valid = await cancel("api-concurrency-valid", { "if-match": "\"1\"" });
    expect(valid.status).toBe(200);
    expect((await valid.json()).data).toMatchObject({ version: 2, aggregateStatus: "CANCELLED" });

    const replay = await cancel("api-concurrency-valid", { "if-match": "\"1\"", "x-correlation-id": "different-correlation" });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ version: 2, aggregateStatus: "CANCELLED" });
  });

  it("rejects whitespace-only request notes and duplicate override reasons", async () => {
    const auth = await login();
    const request = (key: string, item: Record<string, unknown>, override = false) => POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "idempotency-key": key,
        ...(override ? { "x-duplicate-override": "true" } : {})
      },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [item], ...(override ? { overrideReason: "   " } : {}) })
    }), params(["diagnostic-requests"]));

    expect((await request("api-blank-note", { serviceId: "service-hemogram", note: "   " })).status).toBe(400);
    expect((await request("api-blank-override", { serviceId: "service-hemogram" }, true)).status).toBe(400);
    const blankOptionalIdempotency = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "idempotency-key": " "
      },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
    }), params(["diagnostic-requests"]));
    expect(blankOptionalIdempotency.status).toBe(400);
    expect((await blankOptionalIdempotency.json()).error.code).toBe("VALIDATION_ERROR");

    const falseOverride = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "idempotency-key": "api-false-override",
        "x-duplicate-override": "false"
      },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
    }), params(["diagnostic-requests"]));
    expect(falseOverride.status).toBe(400);
    expect((await falseOverride.json()).error.code).toBe("VALIDATION_ERROR");
    const missingIdempotency = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "x-duplicate-override": "true" },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }], overrideReason: "Decisão clínica confirmada" })
    }), params(["diagnostic-requests"]));
    expect(missingIdempotency.status).toBe(400);
    expect((await missingIdempotency.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects unknown fields inside nested request items", async () => {
    const auth = await login();
    const response = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "idempotency-key": "api-request-nested-unknown"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "URGENT",
        items: [{ serviceId: "service-hemogram", unexpectedClinicalField: "must-not-be-discarded" }]
      })
    }), params(["diagnostic-requests"]));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-object JSON bodies at the command boundary", async () => {
    const auth = await login();
    const response = await PATCH(new Request("http://localhost/api/v1/results/result-missing/draft", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf },
      body: JSON.stringify([])
    }), params(["results", "result-missing", "draft"]));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires versioned reasoned confirmation for notification acknowledgement", async () => {
    const auth = await login();
    const response = await POST(new Request("http://localhost/api/v1/notifications/notification-missing/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "missing-notification-ack" },
      body: JSON.stringify({})
    }), params(["notifications", "notification-missing", "acknowledge"]));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");

    const whitespaceKey = await POST(new Request("http://localhost/api/v1/notifications/notification-missing/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": " " },
      body: JSON.stringify({ expectedVersion: 1, reason: "Confirmação operacional", confirm: true })
    }), params(["notifications", "notification-missing", "acknowledge"]));
    expect(whitespaceKey.status).toBe(400);
    expect((await whitespaceKey.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const headerVersion = await POST(new Request("http://localhost/api/v1/notifications/notification-missing/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "header-version-notification-ack", "if-match": "1" },
      body: JSON.stringify({ reason: "Confirmação operacional", confirm: true })
    }), params(["notifications", "notification-missing", "acknowledge"]));
    expect(headerVersion.status).toBe(404);
  });

  it("exposes bounded metrics only to readiness-capable administrators", async () => {
    const admin = await login("admin@cvg.local");
    const store = await getRuntimeStoreAsync();
    const originalRead = store.readState.bind(store);
    const freshRead = vi.spyOn(store, "readState").mockImplementation(async () => ({ ...await originalRead(), outbox: [] }));
    const auditRead = vi.spyOn(store, "readAuditMetrics").mockResolvedValue({ recollectionRate: 0.25, resultViewLatencySeconds: 12 });
    const outboxRead = vi.spyOn(store, "readOutboxMetrics").mockResolvedValue({ pending: 250, oldestAvailableAt: "2026-01-01T00:00:00.000Z" });
    const response = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(freshRead).toHaveBeenCalled();
    expect(auditRead).toHaveBeenCalledTimes(1);
    expect(outboxRead).toHaveBeenCalledTimes(1);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("http_requests_total");
    expect(body).toContain("cvg_outbox_pending 250\n");
    expect(Number(body.match(/^cvg_outbox_oldest_age_seconds (.+)$/m)?.[1])).toBeGreaterThan(0);
    expect(body).toContain("cvg_recollection_rate 0.25\n");
    expect(body).toContain("cvg_result_view_latency_seconds 12\n");
    expect(body).not.toContain("patient-thor");

    const vet = await login();
    auditRead.mockClear();
    outboxRead.mockClear();
    const denied = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: vet.cookie } }), params(["metrics"]));
    expect(denied.status).toBe(404);
    expect(auditRead).not.toHaveBeenCalled();
    expect(outboxRead).not.toHaveBeenCalled();

    const unauthenticated = await GET(new Request("http://localhost/api/v1/metrics"), params(["metrics"]));
    expect(unauthenticated.status).toBe(401);
    expect(auditRead).not.toHaveBeenCalled();
    expect(outboxRead).not.toHaveBeenCalled();
  });

  it.each(["readAuditMetrics", "readOutboxMetrics"] as const)("fails metrics closed when %s is unavailable", async (method) => {
    const admin = await login("admin@cvg.local");
    const store = await getRuntimeStoreAsync();
    const failedRead = vi.spyOn(store, method).mockRejectedValue(new Error("aggregate-private-database-failure"));

    const response = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
    const body = await response.text();
    expect(failedRead).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(JSON.parse(body).error.code).toBe("INTERNAL_ERROR");
    expect(body).not.toContain("aggregate-private-database-failure");
    expect(body).not.toContain("cvg_outbox_pending");
  });

  it("emits realtime poll, resync, and closure metrics without event identifiers", async () => {
    const auth = await login();
    const stream = await GET(new Request("http://localhost/api/v1/realtime/events", {
      headers: { cookie: auth.cookie, "last-event-id": "expired-event" }
    }), params(["realtime", "events"]));
    const reader = stream.body?.getReader();
    expect(reader).toBeTruthy();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: resync_required");

    const beforeClose = renderPrometheus();
    expect(beforeClose).toContain('cvg_realtime_poll_duration_ms_count{mode="stream",outcome="success"} 1');
    expect(beforeClose).toContain('cvg_realtime_resyncs_total{reason="event_window_expired"} 1');
    expect(beforeClose).not.toContain("expired-event");

    await reader!.cancel();
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="consumer_cancel"} 1');
  });

  it("wakes an authorized stream after a local mutation while retaining polling fallback", async () => {
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const auth = await login();
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
      reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();

      const created = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "realtime-local-wake" },
        body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
      }), params(["diagnostic-requests"]));
      expect(created.status).toBe(201);

      const next = await Promise.race([
        reader!.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 500))
      ]);
      expect(next.done).toBe(false);
      expect(new TextDecoder().decode(next.value)).toContain("event: diagnostic.updated");
    } finally {
      await reader?.cancel();
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
    }
  });

  it("rejects a stream above the configured connection budget and releases it on cancel", async () => {
    const previousLimit = process.env.REALTIME_MAX_CONNECTIONS;
    process.env.REALTIME_MAX_CONNECTIONS = "1";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const auth = await login();
      const first = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
      reader = first.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();

      const second = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
      expect(second.status).toBe(429);
      expect((await second.json()).error.code).toBe("REALTIME_CAPACITY");
      expect(renderPrometheus()).toContain('cvg_realtime_connection_rejections_total{reason="connection_limit"} 1');
    } finally {
      await reader?.cancel();
      if (previousLimit === undefined) delete process.env.REALTIME_MAX_CONNECTIONS;
      else process.env.REALTIME_MAX_CONNECTIONS = previousLimit;
    }
    expect(renderPrometheus()).toContain("cvg_sse_connections 0");
  });

  it("fails closed and records a bounded timeout when the persistence poll stalls", async () => {
    const previousTimeout = process.env.REALTIME_POLL_TIMEOUT_MS;
    process.env.REALTIME_POLL_TIMEOUT_MS = "5";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const auth = await login();
      const store = await getRuntimeStoreAsync();
      const originalRead = store.readRealtimeSnapshot.bind(store);
      const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockImplementation(async (limit) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return originalRead(limit);
      });

      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
      reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      const result = await reader!.read();
      expect(result.done).toBe(true);
      expect(realtimeRead).toHaveBeenCalledWith(100);
      expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="poll_timeout"} 1');
      expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="poll_timeout"} 1');
    } finally {
      await reader?.cancel();
      if (previousTimeout === undefined) delete process.env.REALTIME_POLL_TIMEOUT_MS;
      else process.env.REALTIME_POLL_TIMEOUT_MS = previousTimeout;
    }
  });

  it("fails closed when an unsupported notification adapter is selected", async () => {
    const previousAdapter = process.env.REALTIME_NOTIFICATION_ADAPTER;
    process.env.REALTIME_NOTIFICATION_ADAPTER = "postgres-listen";
    const failure = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: failure
    });
    try {
      const auth = await login();
      const response = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: auth.cookie } }), params(["realtime", "events"]));
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("REALTIME_ADAPTER_UNAVAILABLE");
      expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="adapter_unavailable"} 1');
      expect(failure).toHaveBeenCalledWith("http.failure", expect.objectContaining({ errorCode: "REALTIME_ADAPTER_UNAVAILABLE", status: 500 }));
    } finally {
      if (previousAdapter === undefined) delete process.env.REALTIME_NOTIFICATION_ADAPTER;
      else process.env.REALTIME_NOTIFICATION_ADAPTER = previousAdapter;
    }
  });

  it("tracks active SSE connections and cleans the gauge when the client disconnects", async () => {
    const admin = await login("admin@cvg.local");
    const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: admin.cookie } }), params(["realtime", "events"]));
    const reader = stream.body?.getReader();
    expect(reader).toBeTruthy();
    await reader!.read();

    const active = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
    expect(await active.text()).toContain("cvg_sse_connections 1");

    await reader!.cancel();
    const inactive = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
    expect(await inactive.text()).toContain("cvg_sse_connections 0");
  });

  it("collapses a fast poll interval into one shared aggregate read per cadence", async () => {
    const vet = await login();
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    const previousCadence = process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "100";
    const store = await getRuntimeStoreAsync();
    let inFlight = 0;
    let maximumInFlight = 0;
    let calls = 0;
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body!.getReader();
      // Drain the stream so backpressure never closes it before the window ends.
      const draining = (async () => {
        while (!(await reader.read()).done) {
          // discard heartbeat frames
        }
      })();

      const originalRead = store.readRealtimeSnapshot.bind(store);
      const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockImplementation(async (limit) => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 35));
        try {
          return await originalRead(limit);
        } finally {
          inFlight -= 1;
        }
      });

      // Roughly twenty-five poll ticks elapse here. PROD-104 requires them to
      // collapse into a handful of shared reads with no overlapping persistence
      // poll, instead of one aggregate read per connection per tick.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(3);
      expect(maximumInFlight).toBe(1);
      expect(realtimeRead).toHaveBeenCalledWith(100);
      await reader.cancel();
      await draining;
    } finally {
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
      if (previousCadence === undefined) delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
      else process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = previousCadence;
    }
  });

  it("closes an SSE stream safely when a fresh heartbeat read fails", async () => {
    const vet = await login();
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    const previousCadence = process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "25";
    const store = await getRuntimeStoreAsync();
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();
      const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockRejectedValue(new Error("fresh state unavailable"));

      let done = false;
      for (let attempt = 0; attempt < 10 && !done; attempt += 1) {
        const result = await Promise.race([
          reader!.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30))
        ]);
        if (result && "done" in result) done = result.done;
      }
      expect(done).toBe(true);
      expect(realtimeRead).toHaveBeenCalledWith(100);
    } finally {
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
      if (previousCadence === undefined) delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
      else process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = previousCadence;
    }
  });

  it("closes an existing SSE stream after the actor role is changed", async () => {
    const vet = await login();
    const admin = await login("admin@cvg.local");
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();

      const reauth = await POST(new Request("http://localhost/api/v1/session/reauth", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
        body: JSON.stringify({ password: "api-test-password" })
      }), params(["session", "reauth"]));
      expect(reauth.status).toBe(200);
      const updated = await POST(new Request("http://localhost/api/v1/users/user-vet/roles", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf, "idempotency-key": "sse-role-revocation" },
        body: JSON.stringify({ role: "MANAGER", departmentCode: "INPATIENT", active: true, expectedVersion: 1, reason: "Revogar autorização antiga da conexão", confirm: true })
      }), params(["users", "user-vet", "roles"]));
      expect(updated.status).toBe(200);

      let done = false;
      for (let attempt = 0; attempt < 10 && !done; attempt += 1) {
        const result = await Promise.race([
          reader!.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30))
        ]);
        if (result && "done" in result) done = result.done;
      }
      expect(done).toBe(true);
    } finally {
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
    }
  });

  it("closes an existing SSE stream after the session is revoked", async () => {
    const vet = await login();
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();

      const logout = await POST(new Request("http://localhost/api/v1/session/logout", {
        method: "POST",
        headers: { cookie: vet.cookie, "x-csrf-token": vet.csrf }
      }), params(["session", "logout"]));
      expect(logout.status).toBe(200);

      let done = false;
      for (let attempt = 0; attempt < 10 && !done; attempt += 1) {
        const result = await Promise.race([
          reader!.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30))
        ]);
        if (result && "done" in result) done = result.done;
      }
      expect(done).toBe(true);
    } finally {
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
    }
  });

  it("rejects an unknown attachment before buffering its body", async () => {
    const auth = await login();
    process.env.ATTACHMENT_MAX_BYTES = "10";
    try {
      const response = await PUT(new Request("http://localhost/api/v1/attachments/attachment-missing/content", {
        method: "PUT",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/octet-stream" },
        body: new Uint8Array(11)
      }), params(["attachments", "attachment-missing", "content"]));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      delete process.env.ATTACHMENT_MAX_BYTES;
    }
  });

  it("rejects unsupported list filters instead of silently returning an empty page", async () => {
    const auth = await login();
    const response = await GET(new Request("http://localhost/api/v1/diagnostic-requests?status=NOT_A_STATUS", {
      headers: { cookie: auth.cookie }
    }), params(["diagnostic-requests"]));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates and applies request query filters at the HTTP boundary", async () => {
    const auth = await login();
    const create = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "api-filter-request" },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "EMERGENCY", items: [{ serviceId: "service-hemogram" }] })
    }), params(["diagnostic-requests"]));
    expect(create.status).toBe(201);

    const filtered = await GET(new Request("http://localhost/api/v1/diagnostic-requests?departmentId=LABORATORY&priority=EMERGENCY&serviceId=service-hemogram&overdue=false&limit=10", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).data).toHaveLength(1);

    const invalid = await GET(new Request("http://localhost/api/v1/diagnostic-requests?priority=NOT_A_PRIORITY", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");

    const invalidDepartment = await GET(new Request("http://localhost/api/v1/diagnostic-requests?departmentCode=!!!", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(invalidDepartment.status).toBe(400);
    expect((await invalidDepartment.json()).error.code).toBe("VALIDATION_ERROR");

    const invalidService = await GET(new Request("http://localhost/api/v1/diagnostic-requests?serviceId=svc.test", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(invalidService.status).toBe(400);
    expect((await invalidService.json()).error.code).toBe("VALIDATION_ERROR");

    const paddedService = await GET(new Request("http://localhost/api/v1/diagnostic-requests?serviceId=%20service-hemogram%20", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(paddedService.status).toBe(400);
    expect((await paddedService.json()).error.code).toBe("VALIDATION_ERROR");

    for (const from of ["2026-08-22", " 2026-08-22T00:00:00Z "]) {
      const invalidDate = await GET(new Request(`http://localhost/api/v1/diagnostic-requests?from=${encodeURIComponent(from)}`, { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
      expect(invalidDate.status).toBe(400);
      expect((await invalidDate.json()).error.code).toBe("VALIDATION_ERROR");
    }

    const reversedRange = await GET(new Request("http://localhost/api/v1/diagnostic-requests?from=2026-08-23T00%3A00%3A00Z&to=2026-08-22T00%3A00%3A00Z", { headers: { cookie: auth.cookie } }), params(["diagnostic-requests"]));
    expect(reversedRange.status).toBe(400);
    expect((await reversedRange.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns scoped search results with cursor metadata and validates filters", async () => {
    const auth = await login();
    const create = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf, "idempotency-key": "api-search-request" },
      body: JSON.stringify({ patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-hemogram" }] })
    }), params(["diagnostic-requests"]));
    expect(create.status).toBe(201);

    const response = await GET(new Request("http://localhost/api/v1/search?q=Oliveira&types=REQUEST&department=LABORATORY&limit=1", { headers: { cookie: auth.cookie } }), params(["search"]));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data[0]).toMatchObject({ type: "REQUEST", patient: "Thor", priority: "URGENT" });
    expect(body.meta.limit).toBe(1);

    const invalid = await GET(new Request("http://localhost/api/v1/search?q=Thor&status=NOT_A_STATUS", { headers: { cookie: auth.cookie } }), params(["search"]));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");

    const oversizedQuery = await GET(new Request(`http://localhost/api/v1/search?q=${"x".repeat(201)}`, { headers: { cookie: auth.cookie } }), params(["search"]));
    expect(oversizedQuery.status).toBe(400);
    expect((await oversizedQuery.json()).error.code).toBe("VALIDATION_ERROR");

    const missingQuery = await GET(new Request("http://localhost/api/v1/search", { headers: { cookie: auth.cookie } }), params(["search"]));
    expect(missingQuery.status).toBe(400);

    const whitespaceQuery = await GET(new Request("http://localhost/api/v1/search?q=%20%20", { headers: { cookie: auth.cookie } }), params(["search"]));
    expect(whitespaceQuery.status).toBe(400);

    for (const types of ["REQUEST,", ",REQUEST", "REQUEST,,ITEM"]) {
      const malformedTypes = await GET(new Request(`http://localhost/api/v1/search?q=Thor&types=${encodeURIComponent(types)}`, { headers: { cookie: auth.cookie } }), params(["search"]));
      expect(malformedTypes.status, `types=${types}`).toBe(400);
      expect((await malformedTypes.json()).error.code).toBe("VALIDATION_ERROR");
    }

    const reversedRange = await GET(new Request("http://localhost/api/v1/search?q=Thor&from=2026-08-23T00%3A00%3A00Z&to=2026-08-22T00%3A00%3A00Z", { headers: { cookie: auth.cookie } }), params(["search"]));
    expect(reversedRange.status).toBe(400);
    expect((await reversedRange.json()).error.code).toBe("VALIDATION_ERROR");

    const missingTimelineContext = await GET(new Request("http://localhost/api/v1/timeline", { headers: { cookie: auth.cookie } }), params(["timeline"]));
    expect(missingTimelineContext.status).toBe(400);
  });

  it("rejects invalid queue limits at the HTTP boundary", async () => {
    const auth = await login("lab@cvg.local");
    const response = await GET(new Request("http://localhost/api/v1/queues/LABORATORY/items?limit=-1", {
      headers: { cookie: auth.cookie }
    }), params(["queues", "LABORATORY", "items"]));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("exposes scoped patient diagnostics and audit events through read endpoints", async () => {
    const vet = await login();
    const create = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: vet.cookie,
        "x-csrf-token": vet.csrf,
        "idempotency-key": "api-read-model-request"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "ROUTINE",
        items: [{ serviceId: "service-hemogram" }]
      })
    }), params(["diagnostic-requests"]));
    expect(create.status).toBe(201);

    const diagnostics = await GET(new Request("http://localhost/api/v1/patients/patient-thor/diagnostics?limit=10", {
      headers: { cookie: vet.cookie }
    }), params(["patients", "patient-thor", "diagnostics"]));
    expect(diagnostics.status).toBe(200);
    const diagnosticsBody = await diagnostics.json();
    expect(diagnosticsBody.data).toMatchObject({
      items: expect.any(Array),
      workspace: {
        asOf: expect.any(String),
        currentContext: expect.objectContaining({ encounterId: "encounter-thor", admissionId: "admission-thor" }),
        summary: expect.objectContaining({ requestCount: 1, itemCount: 1 })
      }
    });
    expect(diagnosticsBody.data.items).toHaveLength(1);

    const timeline = await GET(new Request(`http://localhost/api/v1/timeline?requestId=${JSON.parse(await create.clone().text()).data.id}&limit=1`, {
      headers: { cookie: vet.cookie }
    }), params(["timeline"]));
    expect(timeline.status).toBe(200);
    expect((await timeline.json()).meta.limit).toBe(1);

    const manager = await login("manager@cvg.local");
    const audit = await GET(new Request("http://localhost/api/v1/audit-events?limit=10", {
      headers: { cookie: manager.cookie }
    }), params(["audit-events"]));
    expect(audit.status).toBe(200);
    expect((await audit.json()).data.length).toBeGreaterThan(0);
  });

  it("returns the dashboard indicator contract with scope metadata", async () => {
    const manager = await login("manager@cvg.local");
    const response = await GET(new Request("http://localhost/api/v1/dashboard", { headers: { cookie: manager.cookie } }), params(["dashboard"]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.window).toMatchObject({ kind: "CURRENT_STATE", timezone: "America/Sao_Paulo" });
    expect(body.data.window.asOf).toBe(body.data.updatedAt);
    expect(body.data.dataQuality).toMatchObject({ status: "FRESH", asOf: body.data.updatedAt });
    expect(body.data.attention).toEqual(expect.any(Array));
    expect(body.data.departments).toEqual(expect.any(Array));
    expect(body.data.indicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "overdue", definition: expect.any(String), denominator: expect.any(Number), nextAction: expect.any(String) }),
      expect.objectContaining({ key: "critical", definition: expect.any(String), denominator: expect.any(Number), nextAction: expect.any(String) })
    ]));
  });

  it("keeps the new dashboard and queue projections scoped by department", async () => {
    const vet = await login();
    const create = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: vet.cookie,
        "x-csrf-token": vet.csrf,
        "idempotency-key": "api-operational-scope-projection"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "URGENT",
        items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
      })
    }), params(["diagnostic-requests"]));
    expect(create.status).toBe(201);

    const lab = await login("lab@cvg.local");
    const labDashboard = await GET(new Request("http://localhost/api/v1/dashboard", { headers: { cookie: lab.cookie } }), params(["dashboard"]));
    const labDashboardBody = await labDashboard.json();
    expect(labDashboard.status).toBe(200);
    expect(labDashboardBody.data.attention.every((item: { departmentCode: string }) => item.departmentCode === "LABORATORY")).toBe(true);

    const labQueue = await GET(new Request("http://localhost/api/v1/queues/LABORATORY/items", { headers: { cookie: lab.cookie } }), params(["queues", "LABORATORY", "items"]));
    expect(labQueue.status).toBe(200);
    expect((await labQueue.json()).data.every((item: { departmentCode: string }) => item.departmentCode === "LABORATORY")).toBe(true);

    const crossDepartmentQueue = await GET(new Request("http://localhost/api/v1/queues/RADIOLOGY/items", { headers: { cookie: lab.cookie } }), params(["queues", "RADIOLOGY", "items"]));
    expect(crossDepartmentQueue.status).toBe(404);
    expect((await crossDepartmentQueue.json()).error.code).toBe("SCOPE_DENIED");

    const rx = await login("rx@cvg.local");
    const rxDashboard = await GET(new Request("http://localhost/api/v1/dashboard", { headers: { cookie: rx.cookie } }), params(["dashboard"]));
    expect((await rxDashboard.json()).data.attention.every((item: { departmentCode: string }) => item.departmentCode === "RADIOLOGY")).toBe(true);
  });

  it("serves a scoped report with attachment metadata after release", async () => {
    const vet = await login();
    const create = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: vet.cookie,
        "x-csrf-token": vet.csrf,
        "idempotency-key": "api-report-request"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "ROUTINE",
        items: [{ serviceId: "service-hemogram" }]
      })
    }), params(["diagnostic-requests"]));
    const created = await create.json();
    const itemId = created.data.items[0].id as string;

    const lab = await login("lab@cvg.local");
    const receive = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/receive-sample`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "api-report-receive" },
      body: JSON.stringify({ accessionCode: "ACC-API-REPORT", sampleType: "EDTA", expectedVersion: created.data.items[0].version })
    }), params(["diagnostic-items", itemId, "receive-sample"]));
    const received = await receive.json();
    const start = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/start-processing`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "api-report-start" },
      body: JSON.stringify({ expectedVersion: received.data.items[0].version })
    }), params(["diagnostic-items", itemId, "start-processing"]));
    expect(start.status).toBe(200);
    const started = await start.json();
    const draft = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/results`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "api-report-draft" },
      body: JSON.stringify({ narrative: "Hemograma dentro do protocolo.", content: syntheticHemogramContent(), expectedVersion: started.data.item.version })
    }), params(["diagnostic-items", itemId, "results"]));
    const draftBody = await draft.json();
    const release = await POST(new Request(`http://localhost/api/v1/results/${draftBody.data.result.id}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "api-report-release" },
      body: JSON.stringify({ expectedVersion: draftBody.data.result.version })
    }), params(["results", draftBody.data.result.id, "release"]));
    expect(release.status).toBe(200);

    const report = await GET(new Request(`http://localhost/api/v1/reports/${draftBody.data.result.id}`, { headers: { cookie: vet.cookie } }), params(["reports", draftBody.data.result.id]));
    expect(report.status).toBe(200);
    expect((await report.json()).data).toMatchObject({ result: { id: draftBody.data.result.id }, attachments: [] });
  });
});
