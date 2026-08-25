import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./route";
import { getRuntimeStoreAsync, resetRuntimeStore } from "../../../../server/store/runtime";
import { resetMetrics } from "../../../../server/observability/metrics";

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
    const freshRead = vi.spyOn(store, "readState");
    const response = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: admin.cookie } }), params(["metrics"]));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(freshRead).toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("http_requests_total");
    expect(body).not.toContain("patient-thor");

    const vet = await login();
    const denied = await GET(new Request("http://localhost/api/v1/metrics", { headers: { cookie: vet.cookie } }), params(["metrics"]));
    expect(denied.status).toBe(404);
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

  it("serializes fresh SSE heartbeat reads instead of overlapping slow persistence polls", async () => {
    const vet = await login();
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    const store = await getRuntimeStoreAsync();
    let inFlight = 0;
    let maximumInFlight = 0;
    let calls = 0;
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();

      const originalRead = store.readState.bind(store);
      vi.spyOn(store, "readState").mockImplementation(async () => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 35));
        try {
          return await originalRead();
        } finally {
          inFlight -= 1;
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(maximumInFlight).toBe(1);
      await reader!.cancel();
    } finally {
      if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
      else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
    }
  });

  it("closes an SSE stream safely when a fresh heartbeat read fails", async () => {
    const vet = await login();
    const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
    process.env.REALTIME_STREAM_INTERVAL_MS = "10";
    const store = await getRuntimeStoreAsync();
    try {
      const stream = await GET(new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: vet.cookie } }), params(["realtime", "events"]));
      const reader = stream.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();
      vi.spyOn(store, "readState").mockRejectedValue(new Error("fresh state unavailable"));

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
    expect((await diagnostics.json()).data.items).toHaveLength(1);

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
    expect(body.data.indicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "overdue", definition: expect.any(String), denominator: expect.any(Number), nextAction: expect.any(String) }),
      expect.objectContaining({ key: "critical", definition: expect.any(String), denominator: expect.any(Number), nextAction: expect.any(String) })
    ]));
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
      body: JSON.stringify({ narrative: "Hemograma dentro do protocolo.", content: {}, expectedVersion: started.data.item.version })
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
