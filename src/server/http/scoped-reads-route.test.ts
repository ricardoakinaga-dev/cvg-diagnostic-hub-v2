import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import type { User } from "../domain/models";

const password = "scoped-reads-synthetic-password";
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });
async function fixture() {
  const state = createDemoState(password);
  const store = new MemoryStore(state);
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const service = createApplicationService(store);
  const vet = state.users.find((user) => user.role === "VETERINARIAN")!;
  const requests = [];
  for (const patient of ["thor", "mel"]) {
    requests.push(await service.createRequest(vet, { patientId: `patient-${patient}`, encounterId: `encounter-${patient}`, priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-crp" }] }, { idempotencyKey: `scope-${patient}` }));
  }
  async function update(id: string, patch: Partial<User>) {
    await store.transaction((current) => ({ state: { ...current, users: current.users.map((user) => user.id === id ? { ...user, ...patch } : user) }, result: undefined }));
  }
  async function client(email: string) {
    const login = await loginUser(store, email, password);
    const cookie = `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`;
    return {
      async get(path: string[], query = "") {
        return GET(new Request(`http://localhost/api/v1/${path.join("/")}${query}`, { headers: { cookie } }), params(path));
      },
      async post(path: string[], body: unknown) {
        return POST(new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers: { cookie, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json", "idempotency-key": `command-${path.join("-")}` }, body: JSON.stringify(body) }), params(path));
      }
    };
  }
  return { store, service, requests, update, client };
}

describe.sequential("AAA2 scoped public clinical reads", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => {
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    delete globalThis.__cvgDiagnosticsFileStore;
    delete process.env.APP_DATA_MODE;
    resetRateLimits();
  });

  it("serves the sample label inside the patient scope and answers 404 outside it", async () => {
    const f = await fixture();
    await f.update("user-vet", { patientIds: ["patient-mel"] });
    const client = await f.client("vet@cvg.local");
    const own = (await f.service.getRequest(f.store.getState().users.find((user) => user.id === "user-vet")!, f.requests[1].id)).samples[0];
    const foreign = f.store.getState().samples.find((sample) => sample.requestId === f.requests[0].id)!;
    const allowed = await client.get(["samples", own.id, "label"]);
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data).toMatchObject({ sample: { id: own.id, accessionCode: own.accessionCode, status: "EXPECTED" }, patient: { id: "patient-mel" }, label: { widthMm: 50, heightMm: 30, barcode: { symbology: "code128" } } });
    for (const sampleId of [foreign.id, "sample-unknown"]) {
      const denied = await client.get(["samples", sampleId, "label"]);
      expect(denied.status).toBe(404);
      expect((await denied.json()).error).toMatchObject({ code: "SCOPE_DENIED" });
    }
  });

  it.each(["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"] as const)("filters %s patient scope before queue limits and counts", async (role) => {
    const f = await fixture();
    await f.update("user-vet", { role, departmentCode: "LABORATORY", patientIds: ["patient-mel"] });
    const client = await f.client("vet@cvg.local");
    const queue = await client.get(["queues", "LABORATORY", "items"], "?limit=1");
    expect(queue.status).toBe(200);
    expect((await queue.json()).data).toMatchObject([{ patient: { id: "patient-mel" } }]);
    const listed = await client.get(["diagnostic-requests"], "?limit=1");
    expect(await listed.json()).toMatchObject({ meta: { total: 1 }, data: [{ id: f.requests[1].id }] });
    const dashboard = await client.get(["dashboard"]);
    expect((await dashboard.json()).data.totalActive).toBe(2);
    const events = await (await client.get(["realtime", "events"], "?snapshot=true")).text();
    expect(events).toContain(f.requests[1].id);
    expect(events).not.toContain(f.requests[0].id);
    const denied = await client.get(["diagnostic-items", f.requests[0].items[0].id]);
    expect(denied.status).toBe(404);
  });

  it("limits executor service scope in queues, request projection, search, timeline, dashboard and patient diagnostics", async () => {
    const f = await fixture();
    await f.update("user-lab", { serviceCodes: ["CRP"] });
    const client = await f.client("lab@cvg.local");
    const queue = await client.get(["queues", "LABORATORY", "items"], "?limit=1");
    expect((await queue.json()).data).toMatchObject([{ service: { code: "CRP" } }]);
    const listedResponse = await (await client.get(["diagnostic-requests"], "?limit=1")).json();
    const listed = { ...listedResponse.meta, items: listedResponse.data };
    expect(listed.total).toBe(2);
    expect(listed.items[0].items).toHaveLength(1);
    expect(listed.items[0].items[0].service.code).toBe("CRP");
    expect(listed.nextCursor).toEqual(expect.any(String));
    const secondResponse = await (await client.get(["diagnostic-requests"], `?limit=1&cursor=${encodeURIComponent(listed.nextCursor)}`)).json();
    const secondPage = { ...secondResponse.meta, items: secondResponse.data };
    expect(secondPage.items[0].id).not.toBe(listed.items[0].id);
    expect(secondPage.total).toBe(2);
    const hiddenSearch = (await (await client.get(["search"], "?q=HEMOGRAM&types=ITEM")).json());
    expect(hiddenSearch).toMatchObject({ data: [], meta: { total: 0 } });
    const hiddenFilter = (await (await client.get(["diagnostic-requests"], "?serviceId=service-hemogram")).json());
    expect(hiddenFilter).toMatchObject({ data: [], meta: { total: 0 } });
    expect((await (await client.get(["dashboard"])).json()).data.totalActive).toBe(2);
    const request = f.requests[0];
    expect((await client.get(["diagnostic-items", request.items[0].id])).status).toBe(404);
    const hiddenMutation = await client.post(["diagnostic-items", request.items[0].id, "start-processing"], { expectedVersion: request.items[0].version });
    expect(hiddenMutation.status).toBe(404);
    expect(f.store.getState().items.find((item) => item.id === request.items[0].id)?.status).toBe("REQUESTED");
    expect((await client.get(["timeline"], `?itemId=${request.items[0].id}`)).status).toBe(404);
    const timeline = (await (await client.get(["timeline"], `?requestId=${request.id}`)).json()).data;
    expect(timeline.some((event: { entityId: string }) => event.entityId === request.items[0].id)).toBe(false);
    const diagnostics = (await (await client.get(["patients", "patient-thor", "diagnostics"])).json()).data;
    expect(diagnostics.events.some((event: { entityId: string }) => event.entityId === request.items[0].id)).toBe(false);
    expect(diagnostics.items[0].items).toHaveLength(1);
    await f.store.transaction((state) => ({ state: { ...state, outbox: [...state.outbox, ...request.items.map((item) => ({ ...state.outbox[0], id: `scope-event-${item.id}`, aggregateType: "DiagnosticRequestItem", aggregateId: item.id }))] }, result: undefined }));
    const events = await (await client.get(["realtime", "events"], "?snapshot=true")).text();
    expect(events).toContain(request.items[1].id);
    expect(events).not.toContain(request.items[0].id);
    await f.update("user-lab", { serviceCodes: [] });
    expect((await (await client.get(["queues", "LABORATORY", "items"])).json()).data).toEqual([]);
    expect((await client.get(["patients", "patient-thor"])).status).toBe(404);
  });

  it("does not reveal patient existence through the diagnostics 404 envelope", async () => {
    const f = await fixture();
    await f.update("user-lab", { serviceCodes: ["UNASSIGNED_SERVICE"] });
    const client = await f.client("lab@cvg.local");

    const knownButHidden = await client.get(["patients", "patient-thor", "diagnostics"]);
    const unknown = await client.get(["patients", "patient-does-not-exist", "diagnostics"]);
    const knownBody = await knownButHidden.json();
    const unknownBody = await unknown.json();

    expect(knownButHidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(knownBody.error).toMatchObject({ code: "SCOPE_DENIED", message: "Você não tem acesso a este recurso." });
    expect(unknownBody.error).toMatchObject({ code: "SCOPE_DENIED", message: "Você não tem acesso a este recurso." });
  });

  it("uses delegated manager scope for queue, detail, released result and action, then denies revoked scope", async () => {
    const f = await fixture();
    const lab = f.store.getState().users.find((user) => user.id === "user-lab")!;
    const item = f.requests[0].items[0];
    const received = await f.service.receiveSample(lab, [item.id], { sampleType: "EDTA", expectedVersion: item.version, idempotencyKey: "scope-receive" });
    const started = await f.service.startProcessing(lab, item.id, { expectedVersion: received.items[0].version, idempotencyKey: "scope-start" });
    const draft = await f.service.createResultDraft(lab, item.id, { narrative: "Synthetic scoped result", content: syntheticHemogramContent(), expectedVersion: started.item.version, idempotencyKey: "scope-draft" });
    const released = await f.service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "scope-release" });
    await f.update("user-manager", { departmentCode: "OPERATIONS", managedDepartmentCodes: ["LABORATORY"] });
    const client = await f.client("manager@cvg.local");
    expect((await client.get(["queues", "LABORATORY", "items"])).status).toBe(200);
    expect((await client.get(["diagnostic-items", item.id])).status).toBe(200);
    expect((await client.get(["results", released.result.id])).status).toBe(200);
    expect((await client.get(["reports", released.result.id])).status).toBe(200);
    await f.update("user-lab", { serviceCodes: ["CRP"] });
    const restrictedLab = await f.client("lab@cvg.local");
    expect((await restrictedLab.get(["results", released.result.id])).status).toBe(404);
    expect((await restrictedLab.get(["reports", released.result.id])).status).toBe(404);
    expect((await restrictedLab.get(["results", released.result.id, "attachments"])).status).toBe(404);
    expect((await client.get(["queues", "RADIOLOGY", "items"])).status).toBe(404);
    const cancelItem = f.requests[1].items[1];
    expect((await client.post(["diagnostic-items", cancelItem.id, "cancel"], { expectedVersion: cancelItem.version, reasonCode: "CLINICAL_DECISION", reason: "Synthetic manager cancellation" })).status).toBe(200);
    expect(await (await client.get(["realtime", "events"], "?snapshot=true")).text()).toContain(f.requests[0].id);
    await f.update("user-manager", { managedDepartmentCodes: [] });
    expect(await (await client.get(["realtime", "events"], "?snapshot=true")).text()).not.toContain(f.requests[0].id);
    expect((await client.get(["queues", "LABORATORY", "items"])).status).toBe(404);
    expect((await client.get(["diagnostic-items", item.id])).status).toBe(404);
    expect((await client.get(["results", released.result.id])).status).toBe(404);
    expect((await client.get(["reports", released.result.id])).status).toBe(404);
    const other = f.requests[1].items[0];
    expect((await client.post(["diagnostic-items", other.id, "cancel"], { expectedVersion: other.version, reasonCode: "CLINICAL_DECISION", reason: "Revoked manager cancellation" })).status).toBe(404);
  });
});
