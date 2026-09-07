import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { resetRuntimeStore } from "../store/runtime";

process.env.APP_DATA_MODE = "memory";
process.env.DEMO_PASSWORD = "api-test-password";
process.env.LOGIN_RATE_LIMIT = "100";

type JsonObject = Record<string, unknown>;

const document = JSON.parse(
  readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")
) as JsonObject;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(document, "cvg-openapi");

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const response = await POST(new Request("http://localhost/api/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "api-test-password" })
  }), params(["session", "login"]));
  const cookies = response.headers.get("set-cookie") ?? "";
  const session = cookies.match(/cvg_session=([^;]+)/)?.[1];
  const csrf = cookies.match(/cvg_csrf=([^;]+)/)?.[1];
  if (!session || !csrf) throw new Error("session cookies missing");
  return { cookie: `cvg_session=${session}; cvg_csrf=${csrf}`, csrf };
}

function operation(path: string, method: string): JsonObject {
  return ((document.paths as JsonObject)[path] as JsonObject)[method] as JsonObject;
}

function expectResponseMatches(path: string, method: string, status: number, body: unknown): void {
  const response = (operation(path, method).responses as JsonObject)[String(status)] as JsonObject;
  const media = (response.content as JsonObject)["application/json"] as JsonObject;
  const schema = media.schema as { $ref: string };
  const validate = ajv.compile({ $ref: `cvg-openapi${schema.$ref}` });
  expect(validate(body), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe("OpenAPI schemas against real route responses", () => {
  beforeEach(() => resetRuntimeStore());

  it("validates public, audit, search and timeline envelopes emitted by the runtime", async () => {
    const liveness = await GET(new Request("http://localhost/api/v1/livez"), params(["livez"]));
    const livenessBody = await liveness.json();
    expectResponseMatches("/livez", "get", liveness.status, livenessBody);

    const admin = await login("admin@cvg.local");
    const audit = await GET(new Request("http://localhost/api/v1/audit-events?limit=10", {
      headers: { cookie: admin.cookie }
    }), params(["audit-events"]));
    const auditBody = await audit.json();
    expectResponseMatches("/audit-events", "get", audit.status, auditBody);

    const vet = await login("vet@cvg.local");
    const created = await POST(new Request("http://localhost/api/v1/diagnostic-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: vet.cookie,
        "x-csrf-token": vet.csrf,
        "idempotency-key": "openapi-runtime-response"
      },
      body: JSON.stringify({
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "ROUTINE",
        items: [{ serviceId: "service-hemogram" }]
      })
    }), params(["diagnostic-requests"]));
    const createdBody = await created.json();
    expectResponseMatches("/diagnostic-requests", "post", created.status, createdBody);

    const diagnostics = await GET(new Request("http://localhost/api/v1/patients/patient-thor/diagnostics?limit=10", {
      headers: { cookie: vet.cookie }
    }), params(["patients", "patient-thor", "diagnostics"]));
    expectResponseMatches("/patients/{patientId}/diagnostics", "get", diagnostics.status, await diagnostics.json());

    const search = await GET(new Request("http://localhost/api/v1/search?q=Thor&limit=10", {
      headers: { cookie: vet.cookie }
    }), params(["search"]));
    expectResponseMatches("/search", "get", search.status, await search.json());

    const requestId = createdBody.data.id as string;
    const timeline = await GET(new Request(`http://localhost/api/v1/timeline?requestId=${requestId}&limit=10`, {
      headers: { cookie: vet.cookie }
    }), params(["timeline"]));
    expectResponseMatches("/timeline", "get", timeline.status, await timeline.json());

    const dashboard = await GET(new Request("http://localhost/api/v1/dashboard", {
      headers: { cookie: vet.cookie }
    }), params(["dashboard"]));
    expectResponseMatches("/dashboard", "get", dashboard.status, await dashboard.json());

    const lab = await login("lab@cvg.local");
    const queue = await GET(new Request("http://localhost/api/v1/queues/LABORATORY/items", {
      headers: { cookie: lab.cookie }
    }), params(["queues", "LABORATORY", "items"]));
    expectResponseMatches("/queues/{departmentCode}/items", "get", queue.status, await queue.json());

    const template = await GET(new Request("http://localhost/api/v1/diagnostic-services/service-hemogram/result-template", {
      headers: { cookie: lab.cookie }
    }), params(["diagnostic-services", "service-hemogram", "result-template"]));
    expectResponseMatches("/diagnostic-services/{serviceId}/result-template", "get", template.status, await template.json());

    const itemId = createdBody.data.items[0].id as string;
    const receive = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/receive-sample`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "openapi-runtime-receive" },
      body: JSON.stringify({ accessionCode: "ACC-OPENAPI-1", sampleType: "EDTA", expectedVersion: createdBody.data.items[0].version })
    }), params(["diagnostic-items", itemId, "receive-sample"]));
    const receivedBody = await receive.json();
    const start = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/start-processing`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "openapi-runtime-start" },
      body: JSON.stringify({ expectedVersion: receivedBody.data.items[0].version })
    }), params(["diagnostic-items", itemId, "start-processing"]));
    const startedBody = await start.json();
    const structuredContent = {
      kind: "LABORATORY_STRUCTURED",
      panelCode: "SYNTHETIC_HEMOGRAM",
      panelVersion: 1,
      observations: [
        { analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" },
        { analyteCode: "LEUKOCYTES", value: 8.1, unitCode: "10^9/L" },
        { analyteCode: "PLATELETS", value: 240, unitCode: "10^9/L" },
        { analyteCode: "COMMENT", value: "Amostra adequada", unitCode: "TEXT" }
      ]
    };
    const draft = await POST(new Request(`http://localhost/api/v1/diagnostic-items/${itemId}/results`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: lab.cookie, "x-csrf-token": lab.csrf, "idempotency-key": "openapi-runtime-structured-draft" },
      body: JSON.stringify({ narrative: "Resultado estruturado.", content: structuredContent, expectedVersion: startedBody.data.item.version })
    }), params(["diagnostic-items", itemId, "results"]));
    const draftBody = await draft.json();
    expectResponseMatches("/diagnostic-items/{itemId}/results", "post", draft.status, draftBody);
    const resultId = draftBody.data.result.id as string;
    const result = await GET(new Request(`http://localhost/api/v1/results/${resultId}`, { headers: { cookie: lab.cookie } }), params(["results", resultId]));
    expectResponseMatches("/results/{resultId}", "get", result.status, await result.json());
  });
});
