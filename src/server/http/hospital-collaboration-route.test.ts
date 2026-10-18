import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "../../app/api/v1/[...path]/route";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "../application/service";
import { API_OPERATIONS } from "./api-operation-manifest";
import { hospitalTaskCollaborationHandlers } from "../../app/api/v1/[...path]/hospital-task-collaboration-handlers";
import { systemGroupId } from "../security/access-group-policy";

const password = "hospital-collaboration-synthetic-password"; const params = (path: string[]) => ({ params: Promise.resolve({ path }) });
async function setup() {
  const store = new MemoryStore(createDemoState(password)); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const files = new Map<string, Buffer>(); globalThis.__cvgDiagnosticsFileStore = { put: async (key, content) => { files.set(key, Buffer.from(content)); }, get: async (key) => { const content = files.get(key); if (!content) throw new Error("MISSING"); return content; }, remove: async (key) => { files.delete(key); }, exists: async (key) => files.has(key) };
  const login = await loginUser(store, "vet@cvg.local", password); const headers = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  const command = (method: "POST" | "PATCH" | "PUT" | "DELETE", path: string[], body: unknown, key: string, version?: number) => ({ POST, PATCH, PUT, DELETE })[method](new Request(`http://localhost/api/v1/${path.join("/")}`, { method, headers: { ...headers, "idempotency-key": key, ...(version !== undefined ? { "if-match": `"${version}"` } : {}) }, body: JSON.stringify(body) }), params(path));
  const get = (path: string[], query = "") => GET(new Request(`http://localhost/api/v1/${path.join("/")}${query}`, { headers }), params(path));
  const task = async (draft = false) => { const response = await command("POST", [draft ? "hospital-task-drafts" : "hospital-tasks"], { title: "Rotina HTTP sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-vet" }, draft ? "draft-create" : "task-create"); const body = await response.json(); expect(response.status, JSON.stringify(body.error)).toBe(201); return body.data.task; };
  return { store, headers, command, get, task };
}
describe.sequential("hospital collaboration HTTP contracts", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; delete process.env.APP_DATA_MODE; resetRateLimits(); });
  it("keeps zero initialization local to owned preferences, rejects zero If-Match and uses positive row versions afterward", async () => {
    const c = await setup(); const task = await c.task(); const input = { targetType: "HOSPITAL_TASK", targetId: task.id, favorite: true, favoriteGroup: "Meu turno", expectedVersion: 0 };
    const first = await c.command("PUT", ["work-activity-preferences"], input, "initial"); const body = await first.json(); expect(first.status, JSON.stringify(body.error)).toBe(200); expect(body.data.preference.version).toBe(1);
    expect((await c.command("PUT", ["work-activity-preferences"], input, "zero-header", 0)).status).toBe(400); expect((await c.command("PUT", ["work-activity-preferences"], { ...input, expectedVersion: undefined, favorite: false }, "next", 1)).status).toBe(200);
    const targeted = await c.get(["work-activity-preferences"], `?targetType=HOSPITAL_TASK&targetId=${task.id}`); expect(targeted.status).toBe(200); expect((await targeted.json()).data.items[0].preference.version).toBe(2); expect((await c.get(["work-activity-preferences"], `?targetId=${task.id}`)).status).toBe(400);
    expect((await c.command("PUT", ["work-notifications", "preferences"], { mutedEvents: ["TASK_CHANGED"], expectedVersion: 0 }, "mute")).status).toBe(200);
  });
  it("enforces comment ownership fields, If-Match, CSRF and idempotency with a retained edit history", async () => {
    const c = await setup(); const task = await c.task(); const path = ["hospital-tasks", task.id, "comments"];
    expect((await c.command("POST", path, { body: "Forged", authorId: "other" }, "spoof", 1)).status).toBe(400);
    const created = await c.command("POST", path, { body: "Comentário sintético" }, "comment", 1); const body = await created.json(); expect(created.status, JSON.stringify(body.error)).toBe(201); const commentId = body.data.comment.id;
    expect((await c.command("PATCH", [...path, commentId], { body: "Revisado" }, "edit", 1)).status).toBe(200); expect((await c.command("PATCH", [...path, commentId], { body: "Stale" }, "stale", 1)).status).toBe(409);
    const blocked = await PATCH(new Request(`http://localhost/api/v1/${[...path, commentId].join("/")}`, { method: "PATCH", headers: { cookie: c.headers.cookie, origin: "http://localhost", "content-type": "application/json", "idempotency-key": "no-csrf" }, body: JSON.stringify({ body: "CSRF", expectedVersion: 2 }) }), params([...path, commentId])); expect(blocked.status).toBe(403);
    const listed = await c.get(path); expect((await listed.json()).data.items[0].comment.revisions[0].body).toBe("Comentário sintético"); expect((await c.command("DELETE", [...path, commentId], {}, "delete", 2)).status).toBe(200); expect((await (await c.get(path)).json()).data.items[0].comment.body).toBe("");
  });
  it("uses private bounded binary upload and attachment versions, downloading only after clean finalization", async () => {
    const c = await setup(); const task = await c.task(); const bytes = Buffer.from("%PDF-1.7\nHTTP synthetic attachment\n"); const created = await c.command("POST", ["hospital-tasks", task.id, "attachments", "upload-sessions"], { filename: "synthetic.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") }, "upload", 1); const body = await created.json(); expect(created.status, JSON.stringify(body.error)).toBe(201); const attachmentId = body.data.attachment.id; expect(JSON.stringify(body.data)).not.toContain("storageKey");
    const rejected = await PUT(new Request(`http://localhost/api/v1/hospital-task-attachments/${attachmentId}/content`, { method: "PUT", headers: c.headers, body: bytes }), params(["hospital-task-attachments", attachmentId, "content"])); expect(rejected.status).toBe(415);
    const path = ["hospital-task-attachments", attachmentId, "content"]; expect((await c.get(path)).status).toBe(404); const upload = await PUT(new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "PUT", headers: { ...c.headers, "content-type": "application/octet-stream" }, body: bytes }), params(path)); const uploaded = await upload.json(); expect(upload.status, JSON.stringify(uploaded.error)).toBe(200); expect(uploaded.data.attachment.version).toBe(2);
    expect((await c.command("POST", ["hospital-task-attachments", attachmentId, "finalize"], {}, "finalize", 2)).status).toBe(200); const downloaded = await c.get(path); expect(downloaded.status).toBe(200); expect(downloaded.headers.get("cache-control")).toBe("private, no-store"); expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
  });
  it("publishes a private draft, then reports partial batch outcomes and archives terminal work without deletion", async () => {
    const c = await setup(); const draft = await c.task(true); expect((await (await c.get(["hospital-tasks"])).json()).data.total).toBe(0); expect((await (await c.get(["hospital-tasks"], "?includeDrafts=true")).json()).data.total).toBe(1);
    expect((await c.command("POST", ["hospital-task-drafts", draft.id, "commands"], { command: "PUBLISH" }, "publish", 1)).status).toBe(200);
    const batch = await c.command("POST", ["hospital-tasks", "batch"], { operations: [{ action: "COMMAND", taskId: draft.id, command: "START", expectedVersion: 2 }, { action: "COMMAND", taskId: "hidden", command: "START", expectedVersion: 1 }] }, "batch"); const body = await batch.json(); expect(batch.status, JSON.stringify(body.error)).toBe(200); expect(body.data).toMatchObject({ successCount: 1, failureCount: 1 });
    expect((await c.command("POST", ["hospital-tasks", draft.id, "commands"], { command: "COMPLETE" }, "complete", 3)).status).toBe(200); expect((await c.command("POST", ["hospital-tasks", draft.id, "archive"], { archived: true }, "archive", 4)).status).toBe(200); expect((await (await c.get(["hospital-tasks"])).json()).data.total).toBe(0); expect((await (await c.get(["hospital-tasks"], "?includeArchived=true")).json()).data.total).toBe(1); expect(c.store.getState().hospitalTasks).toHaveLength(1);
  });
  it("retains personal task and comment reactions without advancing the workflow or acknowledging clinical evidence", async () => {
    const c = await setup(); const task = await c.task();
    const reacted = await c.command("PUT", ["hospital-tasks", task.id, "reactions"], { code: "THANKS", active: true }, "thanks", 1); expect(reacted.status).toBe(200); expect((await reacted.json()).data.task.phase).toBe("PENDING");
    expect((await c.command("PUT", ["hospital-tasks", task.id, "reactions"], { code: "THANKS", active: false }, "stale-reaction", 1)).status).toBe(409);
    const comment = await c.command("POST", ["hospital-tasks", task.id, "comments"], { body: "Conversa sintética" }, "comment-reaction", 2); const commentBody = await comment.json(); expect(comment.status).toBe(201); const commentId = commentBody.data.comment.id;
    expect((await c.command("PUT", ["hospital-tasks", task.id, "comments", commentId, "reactions"], { code: "LIKE", active: true }, "like-comment", 1)).status).toBe(200);
    const attachments = await c.get(["hospital-tasks", task.id, "attachments"], "?limit=1"); expect(attachments.status).toBe(200); expect((await attachments.json()).data.items).toEqual([]);
    expect(c.store.getState().hospitalTasks[0].phase).toBe("PENDING"); expect(c.store.getState().hospitalTaskComments[0].reactions).toMatchObject([{ userId: "user-vet", code: "LIKE" }]);
  });
  it("keeps the upload boundary bounded and currently authorized when a verified user context has no browser session identifier", async () => {
    const c = await setup(); const task = await c.task(); const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC_BOUNDARY\n");
    const created = await c.command("POST", ["hospital-tasks", task.id, "attachments", "upload-sessions"], { filename: "bounded.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") }, "bounded-upload", 1); const attachmentId = (await created.json()).data.attachment.id;
    const actor = c.store.getState().users.find(user => user.id === "user-vet")!; expect(actor.sessionId).toBeUndefined();
    const service = createApplicationService(c.store, { storage: globalThis.__cvgDiagnosticsFileStore! });
    const operation = API_OPERATIONS.find(entry => entry.operationId === "uploadHospitalTaskAttachment")!;
    const invoke = () => hospitalTaskCollaborationHandlers.uploadHospitalTaskAttachment.handle({ request: new Request(`http://localhost/api/v1/hospital-task-attachments/${attachmentId}/content`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes.subarray(0, 1) }), path: ["hospital-task-attachments", attachmentId, "content"], actor, store: c.store, service, operation, correlationId: "synthetic-upload-boundary", id: "synthetic-upload-boundary", clientIdentity: { key: "synthetic-boundary" }, rateLimitClientKey: "synthetic-boundary" });
    await expect(invoke()).rejects.toMatchObject({ code: "ATTACHMENT_SIZE_MISMATCH", status: 400 });
    expect(c.store.getState().hospitalTaskAttachments[0]).toMatchObject({ uploadStatus: "INITIATED", version: 1 });
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_task.attachment.upload") } : group) }, result: undefined }));
    await expect(invoke()).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().hospitalTaskAttachments[0]).toMatchObject({ uploadStatus: "INITIATED", version: 1 });
  });
});
