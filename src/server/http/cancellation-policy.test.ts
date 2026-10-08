import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ITEM_STATES, type ItemState } from "@cvg/contracts";
import { POST } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import type { CancelInput } from "../application/service-types";
import type { StoreState, User } from "../domain/models";
import { resetRateLimits } from "../security/rate-limit";
import { loginUser } from "../security/session";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const password = "cancellation-policy-test-password";
const initialState = createDemoState(password);
const elevated = new Set<ItemState>(["RECEIVED", "IN_PROGRESS", "AWAITING_REPORT", "FAILED"]);
const eligible = new Set<ItemState>(["REQUESTED", "SCHEDULED", "RECOLLECTION_REQUIRED", ...elevated]);
const clinicalState = (state: StoreState) => ({
  requests: state.requests, items: state.items, samples: state.samples,
  procedures: state.procedures, schedules: state.schedules, results: state.results,
  resultVersions: state.resultVersions, auditEvents: state.auditEvents,
  notifications: state.notifications, outbox: state.outbox, idempotency: state.idempotency
});

async function fixture(phases: ItemState[] = ["REQUESTED"], actorEmail = "vet@cvg.local", serviceIds?: string[]) {
  const store = new MemoryStore(initialState);
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const service = createApplicationService(store);
  const vet = store.getState().users.find((user) => user.email === "vet@cvg.local")!;
  const created = await service.createRequest(vet, {
    patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE",
    items: phases.map((_, index) => ({ serviceId: serviceIds?.[index] ?? ["service-hemogram", "service-crp"][index] }))
  }, { idempotencyKey: randomUUID() });
  // Seed every state deliberately: the matrix tests cancellation boundaries,
  // while the regression below reaches IN_PROGRESS through real commands.
  await store.transaction((state) => ({ state: {
    ...state,
    users: state.users.map((user) => user.role === "MANAGER" ? { ...user, managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] } : user),
    items: state.items.map((item) => ({ ...item, status: phases[created.items.findIndex((entry) => entry.id === item.id)] ?? item.status }))
  }, result: undefined }));
  const actor = store.getState().users.find((user) => user.email === actorEmail)!;
  const login = await loginUser(store, actor.email, password);
  const command = (expectedVersion: number | undefined = 1): CancelInput => ({ reasonCode: "CLINICAL_DECISION", reason: "Decisão clínica documentada", expectedVersion, idempotencyKey: randomUUID() });
  const http = (kind: "item" | "request", input: CancelInput | Record<string, unknown> = command(), itemId = created.items[0].id) => {
    const path = [kind === "item" ? "diagnostic-items" : "diagnostic-requests", kind === "item" ? itemId : created.id, "cancel"];
    const { idempotencyKey, ...body } = input;
    return POST(new Request(`http://localhost/api/v1/${path.join("/")}`, {
      method: "POST", headers: { "content-type": "application/json", cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken, "idempotency-key": String(idempotencyKey ?? randomUUID()) },
      body: JSON.stringify(body)
    }), { params: Promise.resolve({ path }) });
  };
  return { store, service, actor, created, command, http };
}

describe.sequential("AAA2-002 cancellation phase, scope and atomicity", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => {
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    delete globalThis.__cvgDiagnosticsFileStore;
    delete process.env.APP_DATA_MODE;
    resetRateLimits();
  });

  for (const transport of ["service", "http"] as const) {
    for (const email of ["vet@cvg.local", "manager@cvg.local"]) {
      it.each(ITEM_STATES)(`${transport}: ${email} cancellation at %s obeys phase policy`, async (phase) => {
        const context = await fixture([phase], email, [phase === "SCHEDULED" || phase === "AWAITING_REPORT" ? "service-xray" : "service-hemogram"]);
        const before = clinicalState(context.store.getState());
        const status = !eligible.has(phase) ? 409 : elevated.has(phase) && email.startsWith("vet") ? 403 : 200;
        if (transport === "http") {
          const response = await context.http("item");
          expect(response.status).toBe(status);
        } else {
          const result = context.service.cancelItem(context.actor, context.created.items[0].id, context.command());
          if (status === 200) await expect(result).resolves.toMatchObject({ item: { status: "CANCELLED", version: 2 } });
          else await expect(result).rejects.toMatchObject({ status });
        }
        if (status !== 200) expect(clinicalState(context.store.getState())).toEqual(before);
        else {
          const state = context.store.getState();
          expect(state.items[0]).toMatchObject({ status: "CANCELLED", cancellationReason: "Decisão clínica documentada" });
          expect(state.auditEvents.slice(0, before.auditEvents.length)).toEqual(before.auditEvents);
          expect(state.auditEvents.at(-1)).toMatchObject({ eventType: "DiagnosticItemCancelled", previousState: phase, newState: "CANCELLED" });
        }
      });
    }
  }

  for (const email of ["vet@cvg.local", "manager@cvg.local"]) {
    it.each(ITEM_STATES)(`HTTP: cancelRequest by ${email} at %s uses the same phase policy`, async (phase) => {
      const context = await fixture([phase], email, [phase === "SCHEDULED" || phase === "AWAITING_REPORT" ? "service-xray" : "service-hemogram"]);
      const before = clinicalState(context.store.getState());
      const status = !eligible.has(phase) ? 409 : elevated.has(phase) && email.startsWith("vet") ? 403 : 200;
      expect((await context.http("request")).status).toBe(status);
      if (status !== 200) expect(clinicalState(context.store.getState())).toEqual(before);
      else expect(context.store.getState().items[0]).toMatchObject({ status: "CANCELLED", version: 2 });
    });
  }

  it("blocks the real requested → received → processing regression through HTTP", async () => {
    const context = await fixture();
    const lab = context.store.getState().users.find((user) => user.role === "LAB_TECH")!;
    const received = await context.service.receiveSample(lab, [context.created.items[0].id], { sampleType: "EDTA", expectedVersion: 1, idempotencyKey: randomUUID() });
    const started = await context.service.startProcessing(lab, received.items[0].id, { expectedVersion: 2, idempotencyKey: randomUUID() });
    const before = clinicalState(context.store.getState());
    expect((await context.http("item", context.command(started.item.version))).status).toBe(403);
    expect(clinicalState(context.store.getState())).toEqual(before);
  });

  it.each(["service", "http"] as const)("%s: a late forbidden item rolls back the entire mixed request", async (transport) => {
    const context = await fixture(["REQUESTED", "IN_PROGRESS"]);
    const before = clinicalState(context.store.getState());
    if (transport === "http") expect((await context.http("request")).status).toBe(403);
    else await expect(context.service.cancelRequest(context.actor, context.created.id, context.command())).rejects.toMatchObject({ status: 403 });
    expect(clinicalState(context.store.getState())).toEqual(before);
  });

  it("HTTP: scoped manager cancels every mixed item and stale concurrent request changes no further history", async () => {
    const context = await fixture(["REQUESTED", "IN_PROGRESS"], "manager@cvg.local");
    const before = clinicalState(context.store.getState());
    const responses = await Promise.all([context.http("request"), context.http("request")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const state = context.store.getState();
    expect(state.items.map((item) => item.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(state.requests[0].version).toBe(2);
    expect(state.auditEvents).toHaveLength(before.auditEvents.length + 2);
    expect(state.outbox).toHaveLength(before.outbox.length + 1);
    expect(state.idempotency).toHaveLength(before.idempotency.length + 1);
  });

  it.each(["item", "request"] as const)("HTTP: %s requires reason and version; stale commands preserve clinical state", async (kind) => {
    const context = await fixture(["IN_PROGRESS"], "manager@cvg.local");
    const before = clinicalState(context.store.getState());
    for (const patch of [{ reasonCode: undefined }, { reasonCode: "UNKNOWN" }, { reason: "  " }, { expectedVersion: undefined }, { expectedVersion: 99 }]) {
      const response = await context.http(kind, { ...context.command(), ...patch });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(clinicalState(context.store.getState())).toEqual(before);
    }
  });

  it.each(["item", "request"] as const)("HTTP: %s rechecks patient scope and manager delegation", async (kind) => {
    for (const email of ["vet@cvg.local", "manager@cvg.local"]) {
      const context = await fixture(["REQUESTED"], email);
      await context.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, patientIds: [], managedDepartmentCodes: [] } : user) }, result: undefined }));
      const before = clinicalState(context.store.getState());
      expect((await context.http(kind)).status).toBe(404);
      expect(clinicalState(context.store.getState())).toEqual(before);
    }
  });

  it("HTTP: mixed service scope and foreign IDs fail atomically; explicit eligible subset succeeds", async () => {
    const context = await fixture(["REQUESTED", "IN_PROGRESS"], "manager@cvg.local", ["service-hemogram", "service-xray"]);
    await context.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    const before = clinicalState(context.store.getState());
    expect((await context.http("request")).status).toBe(404);
    expect(clinicalState(context.store.getState())).toEqual(before);
    for (const itemIds of [[], [context.created.items[0].id, "foreign-item"], [context.created.items[0].id, context.created.items[0].id]]) {
      expect((await context.http("request", { ...context.command(), itemIds })).status).toBe(400);
      expect(clinicalState(context.store.getState())).toEqual(before);
    }
    expect((await context.http("request", { ...context.command(), itemIds: [context.created.items[0].id] })).status).toBe(200);
    expect(context.store.getState().items.map((item) => item.status)).toEqual(["CANCELLED", "IN_PROGRESS"]);
  });

  it("HTTP: a terminal item prevents implicit partial cancellation", async () => {
    const context = await fixture(["REQUESTED", "COMPLETED"], "manager@cvg.local");
    const before = clinicalState(context.store.getState());
    expect((await context.http("request")).status).toBe(409);
    expect(clinicalState(context.store.getState())).toEqual(before);
  });

  it.each(["item", "request"] as const)("HTTP: %s replay retains idempotency but rechecks revoked delegation", async (kind) => {
    const context = await fixture(["IN_PROGRESS"], "manager@cvg.local");
    const command = context.command();
    const first = await context.http(kind, command);
    expect(first.status).toBe(200);
    const responseData = (await first.json()).data;
    const afterCancel = clinicalState(context.store.getState());
    const replay = await context.http(kind, command);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(responseData);
    expect(clinicalState(context.store.getState())).toEqual(afterCancel);
    await context.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, managedDepartmentCodes: [] } : user) }, result: undefined }));
    expect((await context.http(kind, command)).status).toBe(404);
    expect(clinicalState(context.store.getState())).toEqual(afterCancel);
  });

  it.each(["item", "request"] as const)("HTTP: %s replay returns only the actor-scoped request projection after a sibling department is revoked", async (kind) => {
    const context = await fixture(["REQUESTED", "REQUESTED"], "manager@cvg.local", ["service-hemogram", "service-xray"]);
    const command = { ...context.command(), ...(kind === "request" ? { itemIds: [context.created.items[0].id] } : {}) };
    expect((await context.http(kind, command)).status).toBe(200);
    const afterCancel = clinicalState(context.store.getState());
    await context.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    const replay = await context.http(kind, command);
    expect(replay.status).toBe(200);
    const replayData = (await replay.json()).data;
    const projectedRequest = kind === "item" ? replayData.request : replayData;
    expect(projectedRequest.itemIds).toEqual([context.created.items[0].id]);
    expect(projectedRequest.items).toHaveLength(1);
    expect(projectedRequest.items[0].id).toBe(context.created.items[0].id);
    expect(clinicalState(context.store.getState())).toEqual(afterCancel);
  });

  it("service: generic state helper cannot bypass the cancellation command", async () => {
    const context = await fixture(["IN_PROGRESS"]);
    const before = clinicalState(context.store.getState());
    await expect(context.service.updateItemState(context.actor, context.created.items[0].id, "CANCELLED", { expectedVersion: 1, idempotencyKey: randomUUID() }, "item.cancel")).rejects.toMatchObject({ status: 409 });
    expect(clinicalState(context.store.getState())).toEqual(before);
  });

  it("service: inactive actor or revoked manager delegation cannot cancel using a stale actor object", async () => {
    for (const patch of [{ active: false }, { managedDepartmentCodes: [] }]) {
      const context = await fixture(["IN_PROGRESS"], "manager@cvg.local");
      await context.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, ...patch } as User : user) }, result: undefined }));
      const before = clinicalState(context.store.getState());
      await expect(context.service.cancelItem(context.actor, context.created.items[0].id, context.command())).rejects.toBeDefined();
      expect(clinicalState(context.store.getState())).toEqual(before);
    }
  });
});
