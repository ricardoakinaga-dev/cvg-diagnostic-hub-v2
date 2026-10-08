import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { LocalFileStore } from "../storage/file-store";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const password = "operation-registry-route-password";
const context = (segments: string[]) => ({ params: Promise.resolve({ path: segments }) });
let sequence = 0;
const roots: string[] = [];

async function fixture() {
  const store = new MemoryStore(createDemoState(password));
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const root = await mkdtemp(path.join(os.tmpdir(), "cvg-dispatch-"));
  roots.push(root);
  const storage = new LocalFileStore(root);
  globalThis.__cvgDiagnosticsFileStore = storage;
  const service = createApplicationService(store, { storage });
  const user = (email: string) => {
    const found = store.getState().users.find((candidate) => candidate.email === email);
    if (!found) throw new Error(`Missing synthetic actor: ${email}`);
    return found;
  };
  const headers = async (email: string) => {
    const login = await loginUser(store, email, password);
    return { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken };
  };
  const vet = user("vet@cvg.local");
  const lab = user("lab@cvg.local");
  return { store, service, user, headers, vet, lab };
}

function command(segments: string[], body: unknown, headers: Record<string, string>, method: "POST" | "PATCH" | "DELETE" = "POST") {
  const request = new Request(`http://localhost/api/v1/${segments.join("/")}`, {
    method, headers: { ...headers, "content-type": "application/json", "idempotency-key": `dispatch-${++sequence}`, "x-correlation-id": "corr-dispatch" }, body: JSON.stringify(body)
  });
  const handler = { POST, PATCH, DELETE }[method];
  return handler(request, context(segments));
}

function read(segments: string[], headers: Record<string, string>, query = "") {
  return GET(new Request(`http://localhost/api/v1/${segments.join("/")}${query}`, { headers }), context(segments));
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body.error)).toBe(status);
  return body.data;
}

async function releasedFixture() {
  const f = await fixture();
  const request = await f.service.createRequest(f.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "released-request" });
  const item = request.items[0];
  const received = await f.service.receiveSample(f.lab, [item.id], { sampleType: "EDTA", expectedVersion: item.version, idempotencyKey: "received" });
  const started = await f.service.startProcessing(f.lab, item.id, { expectedVersion: received.items[0].version, idempotencyKey: "started" });
  const draft = await f.service.createResultDraft(f.lab, item.id, { narrative: "Resultado sintético completo.", content: syntheticHemogramContent(), expectedVersion: started.item.version, idempotencyKey: "draft" });
  const released = await f.service.releaseResult(f.lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "released" });
  return { ...f, released };
}

beforeEach(() => {
  vi.stubEnv("APP_DATA_MODE", "memory");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("STORAGE_SCAN_MODE", "local");
  vi.stubEnv("OUTBOX_INLINE_LOCAL", "false");
  resetRateLimits();
  sequence = 0;
});
afterEach(async () => {
  globalThis.__cvgDiagnosticsStore = undefined;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  globalThis.__cvgDiagnosticsFileStore = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("manifest dispatcher through real clinical HTTP commands", () => {
  it("bounds patient searches by Unicode code points and retains the unfiltered and named reads", async () => {
    const f = await fixture();
    const vet = await f.headers("vet@cvg.local");
    const before = f.store.getState();
    const patients = await data<{ id: string; displayName: string }[]>(await read(["patients"], vet));
    expect(patients).toEqual(expect.arrayContaining([expect.objectContaining({ id: "patient-thor", displayName: "Thor" })]));
    const named = await data<{ id: string }[]>(await read(["patients"], vet, "?q=Thor"));
    expect(named.map((patient) => patient.id)).toEqual(["patient-thor"]);
    await expect(data(await read(["patients"], vet, `?q=${encodeURIComponent("🐾".repeat(200))}`))).resolves.toEqual([]);
    for (const query of ["x".repeat(201), "🐾".repeat(201)]) {
      const response = await read(["patients"], vet, `?q=${encodeURIComponent(query)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "A busca de pacientes é muito longa." } });
    }
    expect((await read(["patients"], {})).status).toBe(401);
    expect(f.store.getState()).toEqual(before);
  });

  it("rejects invalid patients without mutation and creates valid patients only with session CSRF and audit", async () => {
    const f = await fixture();
    const vet = await f.headers("vet@cvg.local");
    const before = f.store.getState();
    const payload = { displayName: "Amora dispatcher", species: "Canino", breed: "Mestiço", sex: "Fêmea", ownerLabel: "Tutor sintético", encounterType: "OUTPATIENT" };
    const invalid = await command(["patients"], { ...payload, displayName: " " }, vet);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "Os dados do paciente são inválidos." } });
    expect((await command(["patients"], payload, {})).status).toBe(401);
    const withoutCsrf = await command(["patients"], payload, { cookie: vet.cookie });
    expect(withoutCsrf.status).toBe(403);
    expect(await withoutCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
    expect(f.store.getState()).toEqual(before);
    const created = await data<{ patient: { id: string }; encounter: { id: string } }>(await command(["patients"], payload, vet), 201);
    expect(f.store.getState().patients).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.patient.id, displayName: payload.displayName, active: true })]));
    expect(f.store.getState().encounters).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.encounter.id, patientId: created.patient.id, status: "OPEN" })]));
    expect(f.store.getState().auditEvents.slice(before.auditEvents.length)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: f.vet.id, entityId: created.patient.id, correlationId: "corr-dispatch" })
    ]));
    expect(await data(await read(["patients", created.patient.id], vet))).toMatchObject({ id: created.patient.id, displayName: payload.displayName });
    const afterCreation = f.store.getState();
    const missing = await read(["patients", "missing-dispatch-patient"], vet);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "SCOPE_DENIED" } });
    expect(f.store.getState()).toEqual(afterCreation);
  });

  it("partitions queue items with explicit overdue filters and rejects malformed booleans without mutation", async () => {
    const f = await fixture();
    const requests = [];
    for (const patient of ["thor", "mel"]) {
      requests.push(await f.service.createRequest(f.vet, { patientId: `patient-${patient}`, encounterId: `encounter-${patient}`, priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: `queue-${patient}` }));
    }
    const overdueId = requests[0].items[0].id;
    const currentId = requests[1].items[0].id;
    await f.store.transaction((state) => ({
      state: { ...state, items: state.items.map((item) => ({ ...item, dueAt: item.id === overdueId ? "2000-01-01T00:00:00.000Z" : "2100-01-01T00:00:00.000Z" })) },
      result: undefined
    }));
    const radiologyRequest = await f.service.createRequest(f.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "queue-radiology" });
    const radiologyItem = radiologyRequest.items[0];
    await f.store.transaction((state) => ({
      state: { ...state, items: state.items.map((item) => item.id === radiologyItem.id ? { ...item, dueAt: "2000-01-01T00:00:00.000Z" } : item) },
      result: undefined
    }));
    const lab = await f.headers("lab@cvg.local");
    const rx = await f.headers("rx@cvg.local");
    const before = f.store.getState();
    const segments = ["queues", "LABORATORY", "items"];
    const all = await data<{ id: string }[]>(await read(segments, lab));
    expect(all.map((item) => item.id).sort()).toEqual([overdueId, currentId].sort());
    expect(all.map((item) => item.id)).not.toContain(radiologyItem.id);
    const overdue = await data<{ id: string; overdue: boolean }[]>(await read(segments, lab, "?overdue=true"));
    expect(overdue).toEqual([expect.objectContaining({ id: overdueId, overdue: true })]);
    const current = await data<{ id: string; overdue: boolean }[]>(await read(segments, lab, "?overdue=false"));
    expect(current).toEqual([expect.objectContaining({ id: currentId, overdue: false })]);
    for (const filter of ["", "TRUE", "0"]) {
      const response = await read(segments, lab, `?overdue=${filter}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "O filtro de atraso é inválido." } });
    }
    expect((await read(["queues", "RADIOLOGY", "items"], lab, "?overdue=true")).status).toBe(404);
    const radiologySegments = ["queues", "RADIOLOGY", "items"];
    const authorizedRadiology = await data<{ id: string; departmentCode: string; overdue: boolean }[]>(await read(radiologySegments, rx, "?overdue=true"));
    expect(authorizedRadiology).toEqual([expect.objectContaining({ id: radiologyItem.id, requestId: radiologyRequest.id, departmentCode: "RADIOLOGY", service: expect.objectContaining({ id: "service-xray" }), overdue: true })]);
    const deniedRadiology = await read(radiologySegments, { ...lab, "x-correlation-id": "corr-dispatch-radiology-scope" }, "?overdue=true");
    expect(deniedRadiology.status).toBe(404);
    expect(deniedRadiology.headers.get("x-correlation-id")).toBe("corr-dispatch-radiology-scope");
    expect(await deniedRadiology.json()).toEqual({ error: { code: "SCOPE_DENIED", message: "Você não tem acesso a este recurso.", correlationId: "corr-dispatch-radiology-scope" } });
    expect(f.store.getState()).toEqual(before);
  });

  it("enforces trusted client login budgets and gives a fresh client a usable authenticated session", async () => {
    const f = await fixture();
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "dispatch-proxy-secret");
    vi.stubEnv("LOGIN_RATE_LIMIT", "1");
    vi.stubEnv("LOGIN_CLIENT_RATE_LIMIT", "1");
    const login = (address: string, secret: string, body: unknown) => command(["session", "login"], body, {
      "x-forwarded-for": address, "x-cvg-proxy-secret": secret
    });
    const before = f.store.getState();
    expect((await login("198.51.100.10", "dispatch-proxy-secret", {})).status).toBe(400);
    const exhausted = await login("198.51.100.10", "dispatch-proxy-secret", { email: "vet@cvg.local", password });
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await login("198.51.100.10", "wrong-secret", {})).status).toBe(400);
    }
    expect(f.store.getState()).toEqual(before);
    const successful = await login("198.51.100.11", "dispatch-proxy-secret", { email: "vet@cvg.local", password });
    const body = await data<{ user: { id: string } }>(successful);
    expect(body.user.id).toBe(f.vet.id);
    const cookies = successful.headers.get("set-cookie") ?? "";
    const token = cookies.match(/cvg_session=([^;]+)/)?.[1];
    const csrf = cookies.match(/cvg_csrf=([^;]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(csrf).toBeTruthy();
    const session = await data<{ user: { id: string } }>(await read(["session", "me"], { cookie: `cvg_session=${token}; cvg_csrf=${csrf}` }));
    expect(session.user.id).toBe(f.vet.id);
    expect(f.store.getState().sessions).toHaveLength(before.sessions.length + 1);
  });

  it.each([
    { segments: ["session", "password"], method: "POST" },
    { segments: ["session", "reauth"], method: "POST" },
    { segments: ["users", "user-lab"], method: "DELETE" },
    { segments: ["users", "user-lab", "roles"], method: "POST" },
    { segments: ["sessions", "missing-session", "revoke"], method: "POST" },
    { segments: ["users", "user-lab", "password"], method: "POST" },
    { segments: ["diagnostic-services"], method: "POST" },
    { segments: ["diagnostic-services", "service-hemogram"], method: "PATCH" }
  ] as const)("rejects invalid administrative input without changing state: $method $segments", async ({ segments, method }) => {
    const f = await fixture();
    const admin = await f.headers("admin@cvg.local");
    const before = f.store.getState();
    const response = await command([...segments], { expectedVersion: 0 }, admin, method);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(f.store.getState()).toEqual(before);
  });

  it("hides operational metrics and dead letters from a clinical actor, including mutations", async () => {
    const f = await fixture();
    const vet = await f.headers("vet@cvg.local");
    await f.store.transaction((state) => ({
      state: {
        ...state,
        outbox: [...state.outbox, ...["reprocess", "discard"].map((action) => ({
          id: `dispatch-failed-${action}`, eventType: "UnsupportedEvent", aggregateType: "DiagnosticRequest",
          aggregateId: "dispatch-request", payload: { requestId: "dispatch-request" },
          consumerType: "DOMAIN_EVENT" as const, routingKey: "domain.UnsupportedEvent",
          status: "FAILED" as const, attempts: 5, availableAt: "2026-08-20T10:00:00.000Z",
          correlationId: "corr-dispatch-dead-letter", deadLetteredAt: "2026-08-20T10:00:00.000Z", lastError: "delivery unavailable"
        }))]
      },
      result: undefined
    }));
    const before = f.store.getState();
    expect((await read(["metrics"], vet)).status).toBe(404);
    expect((await read(["outbox", "dead-letters"], vet)).status).toBe(404);
    for (const action of ["reprocess", "discard"]) {
      const response = await command(["outbox", "dead-letters", `dispatch-failed-${action}`, action], {}, vet);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } });
    }
    expect(f.store.getState()).toEqual(before);
    const admin = await f.headers("admin@cvg.local");
    await data(await command(["outbox", "dead-letters", "dispatch-failed-reprocess", "reprocess"], {}, admin));
    await data(await command(["outbox", "dead-letters", "dispatch-failed-discard", "discard"], {}, admin));
    expect(f.store.getState().outbox.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "dispatch-failed-reprocess", status: "PENDING" },
      { id: "dispatch-failed-discard", status: "DISCARDED" }
    ]);
  });

  it("creates and edits clinical reasons with authorization, validation, version and audit intact", async () => {
    const f = await fixture();
    const admin = await f.headers("admin@cvg.local");
    const vet = await f.headers("vet@cvg.local");
    expect((await command(["reason-codes"], { type: "REJECT", code: "DISPATCH_REASON", label: "Motivo de teste" }, vet)).status).toBe(404);
    expect((await command(["reason-codes"], { type: "invalid" }, admin)).status).toBe(400);
    const created = await data<{ id: string; version: number }>(await command(["reason-codes"], { type: "REJECT", code: "DISPATCH_REASON", label: "Motivo de teste" }, admin), 201);
    expect((await command(["reason-codes", created.id], { label: "" }, admin, "PATCH")).status).toBe(400);
    await data(await command(["reason-codes", created.id], { label: "Motivo revisado", expectedVersion: created.version }, admin, "PATCH"));
    expect(f.store.getState().reasonCodes.find((reason) => reason.id === created.id)).toMatchObject({ label: "Motivo revisado", version: created.version + 1 });
    expect(f.store.getState().auditEvents.slice(-2).every((event) => event.actorId === "user-admin")).toBe(true);
  });

  it("records opening before review and completes only the reviewed current item", async () => {
    const f = await releasedFixture();
    const vet = await f.headers("vet@cvg.local");
    const manager = await f.headers("manager@cvg.local");
    const itemId = f.released.item.id;
    const resultId = f.released.result.id;
    const versionId = f.released.version.id;
    await data(await read(["encounters", "encounter-thor"], vet));
    await data(await read(["admissions", "admission-thor"], vet));
    expect((await command(["results", resultId, "review"], { versionId, expectedVersion: f.released.item.version }, vet)).status).toBe(400);
    expect((await command(["results", resultId, "view"], { versionId: "stale-version", expectedVersion: f.released.item.version }, vet)).status).toBe(409);
    await data(await command(["results", resultId, "view"], { versionId, expectedVersion: f.released.item.version }, vet));
    await data(await command(["results", resultId, "review"], { versionId, expectedVersion: f.released.item.version }, vet));
    const item = f.store.getState().items.find((entry) => entry.id === itemId)!;
    expect(item.status).toBe("REVIEWED");
    await data(await command(["diagnostic-items", itemId, "complete"], { expectedVersion: item.version }, manager));
    expect(f.store.getState().items.find((entry) => entry.id === itemId)?.status).toBe("COMPLETED");
    expect(f.store.getState().auditEvents.filter((event) => event.entityId === versionId).map((event) => event.eventType)).toContain("ResultViewed");
  });

  it("amends and voids a released result without exposing stale or voided content", async () => {
    const f = await releasedFixture();
    const lab = await f.headers("lab@cvg.local");
    const vet = await f.headers("vet@cvg.local");
    const resultId = f.released.result.id;
    const amended = await data<Awaited<ReturnType<typeof f.service.amendResult>>>(await command(["results", resultId, "amend"], { reason: "Correção técnica", narrative: "Narrativa corrigida.", content: syntheticHemogramContent(), expectedVersion: f.released.result.version }, lab));
    expect(amended.previousVersion.status).toBe("SUPERSEDED");
    const released = await f.service.releaseResult(f.lab, resultId, { expectedVersion: amended.result.version, idempotencyKey: "amended-release" });
    await data(await command(["results", resultId, "void"], { reason: "Invalidado para auditoria", expectedVersion: released.result.version }, lab));
    expect((await read(["results", resultId], vet)).status).toBe(404);
    expect(f.store.getState().results.find((result) => result.id === resultId)?.lifecycleStatus).toBe("VOIDED");
  });

  it("requests recollection, receives its replacement and rejects the item with selected reasons", async () => {
    const f = await fixture();
    const request = await f.service.createRequest(f.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "recollection-request" });
    const itemId = request.items[0].id;
    const received = await f.service.receiveSample(f.lab, [itemId], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "original-sample" });
    const lab = await f.headers("lab@cvg.local");
    expect((await command(["diagnostic-items", itemId, "request-recollection"], { expectedVersion: received.items[0].version }, lab)).status).toBe(400);
    const recollection = await data<Awaited<ReturnType<typeof f.service.requestRecollectionForItem>>>(await command(["diagnostic-items", itemId, "request-recollection"], { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version }, lab));
    const replacement = await data<Awaited<ReturnType<typeof f.service.receiveReplacement>>>(await command(["samples", recollection.replacement.id, "receive-replacement"], { sampleType: "EDTA", expectedVersion: recollection.items[0].version }, lab));
    expect(replacement.sample.replacesSampleId).toBe(received.sample.id);
    await data(await command(["diagnostic-items", itemId, "reject"], { reasonCode: "UNPROCESSABLE", expectedVersion: replacement.items[0].version }, lab));
    expect(f.store.getState().items.find((entry) => entry.id === itemId)?.status).toBe("REJECTED");
    await data(await read(["notifications"], await f.headers("vet@cvg.local"), "?filter=ACTIONABLE&limit=100"));
  });

  it("schedules, reschedules, starts and performs a procedure with the proper version at each route", async () => {
    const f = await fixture();
    const request = await f.service.createRequest(f.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "procedure-request" });
    const itemId = request.items[0].id;
    const us = await f.headers("us@cvg.local");
    const window = { startsAt: "2026-08-26T10:00:00.000Z", endsAt: "2026-08-26T10:30:00.000Z", resource: "US-DISPATCH" };
    const scheduled = await data<Awaited<ReturnType<typeof f.service.scheduleProcedure>>>(await command(["diagnostic-items", itemId, "schedule"], { ...window, expectedVersion: request.items[0].version }, us));
    const rescheduled = await data<Awaited<ReturnType<typeof f.service.rescheduleProcedure>>>(await command(["procedures", scheduled.procedure.id, "reschedule"], { ...window, startsAt: "2026-08-26T11:00:00.000Z", endsAt: "2026-08-26T11:30:00.000Z", expectedVersion: scheduled.procedure.version }, us));
    expect(rescheduled.history).toHaveLength(2);
    const started = await data<Awaited<ReturnType<typeof f.service.startProcedure>>>(await command(["diagnostic-items", itemId, "start-procedure"], { expectedVersion: rescheduled.item.version }, us));
    await data(await command(["diagnostic-items", itemId, "mark-performed"], { expectedVersion: started.item.version }, us));
    expect(f.store.getState().items.find((entry) => entry.id === itemId)?.status).toBe("AWAITING_REPORT");
    expect(f.store.getState().schedules.filter((schedule) => schedule.procedureId === scheduled.procedure.id).map((schedule) => schedule.status)).toEqual(["CANCELLED", "COMPLETED"]);
  });

  it("keeps attachment bytes, finalization and download behind authorized versioned handlers", async () => {
    const f = await fixture();
    const rxActor = f.user("rx@cvg.local");
    const request = await f.service.createRequest(f.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "attachment-request" });
    const started = await f.service.startProcedure(rxActor, request.items[0].id, { expectedVersion: request.items[0].version, idempotencyKey: "attachment-start" });
    const performed = await f.service.markProcedurePerformed(rxActor, started.item.id, { expectedVersion: started.item.version, idempotencyKey: "attachment-performed" });
    const draft = await f.service.createResultDraft(rxActor, performed.item.id, { narrative: "Laudo de imagem sintético.", content: {}, expectedVersion: performed.item.version, idempotencyKey: "attachment-draft" });
    const rx = await f.headers("rx@cvg.local");
    const content = Buffer.from("%PDF-1.7\nsynthetic dispatcher report\n");
    const session = await data<Awaited<ReturnType<typeof f.service.createAttachmentUploadSession>>>(await command(["result-versions", draft.version.id, "attachments", "upload-session"], { filename: "laudo.pdf", mimeType: "application/pdf", sizeBytes: content.length, checksum: createHash("sha256").update(content).digest("hex"), expectedVersion: draft.version.version }, rx), 201);
    const attachmentId = session.attachment.id;
    const upload = await PUT(new Request(`http://localhost/api/v1/attachments/${attachmentId}/content`, { method: "PUT", headers: { ...rx, "content-type": "application/octet-stream" }, body: content }), context(["attachments", attachmentId, "content"]));
    await data(upload);
    const version = f.store.getState().resultVersions.find((entry) => entry.id === draft.version.id)!;
    await data(await command(["attachments", attachmentId, "finalize"], { expectedVersion: version.version }, rx));
    expect((await read(["attachments", attachmentId, "download"], rx)).status).toBe(404);
    const result = f.store.getState().results.find((entry) => entry.id === draft.result.id)!;
    await f.service.releaseResult(rxActor, result.id, { expectedVersion: result.version, idempotencyKey: "attachment-release" });
    const download = await read(["attachments", attachmentId, "download"], rx);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content);
    expect((await read(["attachments", attachmentId, "download"], await f.headers("us@cvg.local"))).status).toBe(404);
  });
});
