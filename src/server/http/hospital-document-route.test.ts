import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "../../app/api/v1/[...path]/route";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { systemGroupId } from "../security/access-group-policy";

const password = "hospital-documents-http-test-only";
const content = (text: string) => ({ type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text }] }] });
async function setup() {
  const store = new MemoryStore(createDemoState(password)); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const sessions = new Map<string, Record<string, string>>(); let sequence = 0;
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  const send = async (actorId: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, headers: Record<string, string> = {}) => {
    let session = sessions.get(actorId); if (!session) { const login = await loginUser(store, user(actorId).email, password); session = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" }; sessions.set(actorId, session); }
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers: { ...session, "idempotency-key": `document-http-${++sequence}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const response = await ({ GET, POST, PATCH })[method](request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) }); return { status: response.status, envelope: await response.json() };
  };
  const create = () => send("user-admin", "POST", "hospital-documents", { code: "HTTP_DOCUMENT", title: "Documento sintético", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: content("Versão inicial") });
  const approve = (id: string, version = 1, draftVersion = 1) => send("user-vet", "POST", `hospital-documents/${id}/approve`, { confirm: true, policyReference: "synthetic-only-policy", expectedDraftVersion: draftVersion }, { "if-match": `"${version}"` });
  return { store, send, create, approve };
}
describe.sequential("operational documents HTTP contract", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T17:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });
  it("edits with header-only aggregate revision, rejects another editor's stale version and approves explicitly", async () => {
    const c = await setup(); expect((await c.send("user-admin", "GET", "hospital-documents/options")).status).toBe(200); const created = await c.create(); expect(created.status, JSON.stringify(created.envelope.error)).toBe(201); const id = created.envelope.data.document.id;
    const edit = await c.send("user-admin", "PATCH", `hospital-documents/${id}/draft`, { content: content("Edição corrigida"), expectedDraftVersion: 1 }, { "if-match": '"1"' }); expect(edit.status, JSON.stringify(edit.envelope.error)).toBe(200); expect(edit.envelope.data.document.version).toBe(2);
    expect((await c.send("user-vet", "PATCH", `hospital-documents/${id}/draft`, { title: "Edição concorrente", expectedDraftVersion: 1 }, { "if-match": '"1"' })).status).toBe(409);
    expect((await c.send("user-admin", "POST", `hospital-documents/${id}/approve`, { confirm: true, policyReference: "synthetic", expectedDraftVersion: 2 }, { "if-match": '"2"' })).status).toBe(404);
    const approved = await c.approve(id, 2, 2); expect(approved.status, JSON.stringify(approved.envelope.error)).toBe(200); expect(approved.envelope.data.document.revisions[0]).toMatchObject({ status: "APPROVED", approvedBy: "user-vet", approvedAt: "2026-10-11T17:00:00.000Z" });
    const history = await c.send("user-vet", "GET", `hospital-documents/${id}/history`); expect(history.status).toBe(200); expect(history.envelope.data[0].content).toEqual(content("Edição corrigida"));
    const archive = await c.send("user-admin", "POST", `hospital-documents/${id}/archive`, { archived: true, reason: "Arquivo sintético" }, { "if-match": '"3"' }); expect(archive.status).toBe(200); expect((await c.send("user-vet", "GET", `hospital-documents/${id}/history`)).envelope.data).toHaveLength(1);
  });
  it("keeps the revision actually used and removes its content from task and children after revocation", async () => {
    const c = await setup(); const id = (await c.create()).envelope.data.document.id; expect((await c.approve(id)).status).toBe(200);
    const taskInput = { title: "Tarefa sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", documentIds: [id] }; const parent = await c.send("user-vet", "POST", "hospital-tasks", taskInput); expect(parent.status, JSON.stringify(parent.envelope.error)).toBe(201); const taskId = parent.envelope.data.task.id;
    const child = await c.send("user-vet", "POST", "hospital-tasks", { ...taskInput, title: "Subtarefa sintética", parentTaskId: taskId }); expect(child.status, JSON.stringify(child.envelope.error)).toBe(201);
    const revision = await c.send("user-admin", "POST", `hospital-documents/${id}/revisions`, { content: content("Nova revisão") }, { "if-match": '"2"' }); expect(revision.status).toBe(200); expect((await c.approve(id, 3, 1)).status).toBe(200);
    const original = await c.send("user-vet", "GET", `hospital-tasks/${taskId}`); expect(original.envelope.data.task.documentSnapshots[0]).toMatchObject({ revision: 1, content: content("Versão inicial") }); expect(original.envelope.data.children[0].documentSnapshots[0].revision).toBe(1);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_document.view") } : group) }, result: undefined }));
    const withdrawn = await c.send("user-vet", "GET", `hospital-tasks/${taskId}`); expect(withdrawn.status).toBe(200); expect(withdrawn.envelope.data.task.documentSnapshots).toEqual([]); expect(withdrawn.envelope.data.children[0].documentSnapshots).toEqual([]); expect(JSON.stringify(withdrawn.envelope)).not.toContain("Versão inicial"); expect((await c.send("user-vet", "GET", `hospital-documents/${id}`)).status).toBe(404);
  });
  it("rejects unknown rich nodes, unsafe links and spoofed approval through the public schema", async () => {
    const c = await setup(); const base = { code: "UNSAFE", title: "Teste", departmentCode: "INPATIENT", responsibleUserId: "user-vet" };
    for (const unsafe of [{ type: "hospital-document", version: 1, blocks: [{ type: "html", html: "<script>alert(1)</script>" }] }, { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Texto", href: "javascript:alert(1)" }] }] }]) expect((await c.send("user-admin", "POST", "hospital-documents", { ...base, content: unsafe })).status).toBe(400);
    const id = (await c.create()).envelope.data.document.id; const spoofed = await c.send("user-vet", "POST", `hospital-documents/${id}/approve`, { confirm: true, policyReference: "synthetic", expectedDraftVersion: 1, approvedBy: "other-user" }, { "if-match": '"1"' }); expect(spoofed.status).toBe(400); expect(c.store.getState().hospitalDocuments[0].revisions[0].status).toBe("DRAFT");
  });
});
