import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/v1/[...path]/route";
import { resetRateLimits } from "../security/rate-limit";
import { resetRuntimeStore } from "../store/runtime";

process.env.APP_DATA_MODE = "memory";
process.env.DEMO_PASSWORD = "api-test-password";
process.env.LOGIN_RATE_LIMIT = "100";

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function login(email: string) {
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

function enableSyntheticPolicy(): void {
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "D-01-ROUTE-TEST-v1");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "synthetic-route-test-approval");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-09-01T00:00:00.000Z");
  vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
}

function contextRequest(auth: { cookie: string; csrf: string }, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(new Request("http://localhost/api/v1/admissions/admission-thor/context", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "idempotency-key": "admission-context-route",
      "if-match": "1",
      ...headers
    },
    body: JSON.stringify(body)
  }), params(["admissions", "admission-thor", "context"]));
}

describe("admission context API boundary", () => {
  beforeEach(() => {
    resetRuntimeStore();
    resetRateLimits();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns a safe 503 and no mutation when D-01 is not configured", async () => {
    const manager = await login("manager@cvg.local");
    const response = await contextRequest(manager, {
      action: "BED_CHANGE",
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "Mudança operacional",
      ward: "UTI 2",
      bed: "Box 04"
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: "ADMISSION_CONTEXT_POLICY_UNAVAILABLE",
      details: { nextAction: expect.stringContaining("D-01") }
    });
    expect(JSON.stringify(body)).not.toContain("ADMISSION_CONTEXT_POLICY_APPROVAL_REF");
  });

  it("applies a versioned bed change through the public API", async () => {
    enableSyntheticPolicy();
    const manager = await login("manager@cvg.local");
    const response = await contextRequest(manager, {
      action: "BED_CHANGE",
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "Leito validado pela operação",
      ward: "UTI 2",
      bed: "Box 04"
    }, { "x-correlation-id": "corr-context-route" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBe("corr-context-route");
    expect(body.data).toMatchObject({
      admission: { id: "admission-thor", ward: "UTI 2", bed: "Box 04", version: 2 },
      encounter: { id: "encounter-thor", status: "OPEN" },
      openItemsPreserved: true,
      policyVersion: "D-01-ROUTE-TEST-v1"
    });
  });

  it("denies a veterinarian and rejects action-specific overposting", async () => {
    enableSyntheticPolicy();
    const veterinarian = await login("vet@cvg.local");
    const denied = await contextRequest(veterinarian, {
      action: "BED_CHANGE",
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "Tentativa sem permissão",
      ward: "UTI 2",
      bed: "Box 04"
    });
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe("SCOPE_DENIED");

    const manager = await login("manager@cvg.local");
    const overposted = await contextRequest(manager, {
      action: "DISCHARGE",
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "Alta aprovada externamente",
      ward: "campo não permitido"
    }, { "idempotency-key": "admission-context-overpost" });
    expect(overposted.status).toBe(400);
    expect((await overposted.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("requires optimistic concurrency at the transport boundary", async () => {
    enableSyntheticPolicy();
    const manager = await login("manager@cvg.local");
    const response = await contextRequest(manager, {
      action: "BED_CHANGE",
      effectiveAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "Sem versão",
      ward: "UTI 2",
      bed: "Box 04"
    }, { "if-match": "" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
