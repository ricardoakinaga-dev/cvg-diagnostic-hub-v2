import { DELETE, GET, PATCH, POST, PUT } from "../app/api/v1/[...path]/route";
import { createApplicationService } from "../server/application/service";
import { loginUser } from "../server/security/session";
import { systemGroupId } from "../server/security/access-group-policy";
import { createDemoState } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";

const password = "synthetic-planning-http-password";

export async function hospitalPlannerHttpFixture() {
  const state = createDemoState(password);
  const vet = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "super", email: "super-planning@example.test", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }, { ...vet, id: "vet-b", email: "vet-b-planning@example.test" });
  state.departments.find((department) => department.code === "INPATIENT")!.memberUserIds.push("vet-b");
  const store = new MemoryStore(state);
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const service = createApplicationService(store);
  const sessions = new Map<string, Record<string, string>>();
  let sequence = 0;
  return { store, service, actor: (id: string) => store.getState().users.find((user) => user.id === id)!, async send(actorId: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, overrides: Record<string, string | null> = {}) {
    let session = sessions.get(actorId);
    if (!session) {
      const user = store.getState().users.find((entry) => entry.id === actorId)!;
      const login = await loginUser(store, user.email, password);
      session = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
      sessions.set(actorId, session);
    }
    const headers = new Headers({ ...session, "idempotency-key": `planning-journey-${++sequence}` });
    for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await ({ GET, POST, PATCH, PUT, DELETE })[method](request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
    return { status: response.status, envelope: await response.json() };
  } };
}
