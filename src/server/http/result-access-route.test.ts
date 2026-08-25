import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const password = "route-result-security-password";
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

function actorFrom(store: MemoryStore, email: string) {
  const actor = store.getState().users.find((user) => user.email === email);
  if (!actor) throw new Error(`missing fixture actor: ${email}`);
  return actor;
}

async function routeFixture() {
  const store = new MemoryStore(createDemoState(password));
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const service = createApplicationService(store);
  const vet = actorFrom(store, "vet@cvg.local");
  const lab = actorFrom(store, "lab@cvg.local");
  const request = await service.createRequest(vet, {
    patientId: "patient-thor",
    encounterId: "encounter-thor",
    priority: "ROUTINE",
    items: [{ serviceId: "service-hemogram" }]
  }, { idempotencyKey: "route-security-request" });
  const received = await service.receiveSample(lab, [request.items[0].id], {
    accessionCode: "ACC-ROUTE-SECURITY",
    sampleType: "EDTA",
    expectedVersion: request.items[0].version,
    idempotencyKey: "route-security-receive"
  });
  const started = await service.startProcessing(lab, request.items[0].id, {
    expectedVersion: received.items[0].version,
    idempotencyKey: "route-security-start"
  });
  const draft = await service.createResultDraft(lab, request.items[0].id, {
    narrative: "Draft protegido na rota.",
    content: syntheticHemogramContent(),
    expectedVersion: started.item.version,
    idempotencyKey: "route-security-draft"
  });
  const login = await loginUser(store, vet.email, password);
  return {
    store,
    service,
    lab,
    draft,
    cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`
  };
}

async function clinicalReads(resultId: string, cookie: string) {
  return Promise.all([
    GET(new Request(`http://localhost/api/v1/results/${resultId}`, { headers: { cookie } }), params(["results", resultId])),
    GET(new Request(`http://localhost/api/v1/reports/${resultId}`, { headers: { cookie } }), params(["reports", resultId])),
    GET(new Request(`http://localhost/api/v1/results/${resultId}/versions`, { headers: { cookie } }), params(["results", resultId, "versions"]))
  ]);
}

describe.sequential("clinical result route visibility", () => {
  beforeEach(() => {
    process.env.APP_DATA_MODE = "memory";
    resetRateLimits();
  });

  afterEach(() => {
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    delete globalThis.__cvgDiagnosticsFileStore;
    delete process.env.APP_DATA_MODE;
    resetRateLimits();
  });

  it("returns indistinguishable 404 responses for DRAFT and VOIDED clinical reads", async () => {
    const context = await routeFixture();
    const draftResponses = await clinicalReads(context.draft.result.id, context.cookie);
    expect.soft(draftResponses.map((response) => response.status)).toEqual([404, 404, 404]);
    for (const response of draftResponses) {
      expect.soft((await response.json()).error).toMatchObject({ code: "NOT_FOUND" });
    }

    const released = await context.service.releaseResult(context.lab, context.draft.result.id, {
      expectedVersion: context.draft.result.version,
      idempotencyKey: "route-security-release"
    });
    await context.service.voidResult(context.lab, released.result.id, {
      reason: "Resultado de rota invalidado",
      expectedVersion: released.result.version,
      idempotencyKey: "route-security-void"
    });
    const voidedResponses = await clinicalReads(released.result.id, context.cookie);
    expect.soft(voidedResponses.map((response) => response.status)).toEqual([404, 404, 404]);
    for (const response of voidedResponses) {
      expect.soft((await response.json()).error).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
