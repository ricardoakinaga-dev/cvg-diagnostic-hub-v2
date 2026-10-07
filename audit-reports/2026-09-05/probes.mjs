// Disposable synthetic probes. No database, network server or production data.
// Run: NODE_ENV=test APP_DATA_MODE=memory RATE_LIMIT_MODE=memory STORAGE_SCAN_MODE=local npx tsx audit-reports/2026-09-05/probes.mjs
import { createDemoState } from "../../src/server/store/fixtures.ts";
import { MemoryStore } from "../../src/server/store/memory-store.ts";
import { createApplicationService } from "../../src/server/application/service.ts";
import { aggregateRequestStatus } from "../../src/server/domain/state-machine.ts";
import { loginUser } from "../../src/server/security/session.ts";
import { GET, POST } from "../../src/app/api/v1/[...path]/route.ts";

if (process.env.NODE_ENV !== "test" || process.env.APP_DATA_MODE !== "memory") {
  throw new Error("These probes require explicit test/memory mode.");
}
const state = createDemoState("test-only-demo-password");
const viewer = { ...state.users[0], id: "audit-viewer", email: "audit-viewer@cvg.local", role: "VIEWER", departmentCode: "LABORATORY", patientIds: ["patient-thor"] };
state.users.push(viewer);
const store = new MemoryStore(state);
globalThis.__cvgDiagnosticsStore = store;
const app = createApplicationService(store);
const vet = state.users.find((user) => user.role === "VETERINARIAN");
const lab = state.users.find((user) => user.role === "LAB_TECH");
const manager = state.users.find((user) => user.role === "MANAGER");
const request = await app.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] });

async function sessionHeaders(user) {
  const session = await loginUser(store, user.email, "test-only-demo-password");
  return { cookie: `cvg_session=${session.sessionToken}; cvg_csrf=${session.csrfToken}`, "x-csrf-token": session.csrfToken };
}
async function read(path, headers) {
  const response = await GET(new Request(`http://localhost/api/v1/${path}`, { headers }), { params: Promise.resolve({ path: path.split("/") }) });
  return { status: response.status, body: await response.json() };
}
const viewerHeaders = await sessionHeaders(viewer);
const viewerQueue = await read("queues/LABORATORY/items", viewerHeaders);
const deniedPatient = await read("patients/patient-mel", viewerHeaders);
const managerHeaders = await sessionHeaders(manager);
const managerQueue = await read("queues/LABORATORY/items", managerHeaders);
const managerDetail = await read(`diagnostic-items/${request.items[0].id}`, managerHeaders);

const received = await app.receiveSample(lab, [request.items[0].id], { accessionCode: "AUDIT-001", sampleType: "Sangue", expectedVersion: request.items[0].version, idempotencyKey: "audit-receive" });
const processing = await app.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "audit-start" });
const vetHeaders = await sessionHeaders(vet);
const cancelPath = ["diagnostic-items", request.items[0].id, "cancel"];
const cancelled = await POST(new Request(`http://localhost/api/v1/${cancelPath.join("/")}`, {
  method: "POST",
  headers: { ...vetHeaders, "content-type": "application/json", "idempotency-key": "audit-cancel" },
  body: JSON.stringify({ reasonCode: "CLINICAL_DECISION", expectedVersion: processing.item.version })
}), { params: Promise.resolve({ path: cancelPath }) });
const cancelBody = await cancelled.json();

console.log(JSON.stringify({
  viewerScope: { authorizedPatientIds: viewer.patientIds, queueHttpStatus: viewerQueue.status, returnedPatientIds: viewerQueue.body.data?.map((item) => item.patient.id), directPatientHttpStatus: deniedPatient.status, directPatientError: deniedPatient.body.error?.code },
  delegatedManager: { managedDepartments: manager.managedDepartmentCodes, queueHttpStatus: managerQueue.status, queueCount: managerQueue.body.data?.length, itemHttpStatus: managerDetail.status, itemError: managerDetail.body.error?.code },
  cancelAfterStart: { actorRole: vet.role, before: processing.item.status, httpStatus: cancelled.status, after: cancelBody.data?.item?.status, error: cancelBody.error?.code },
  mixedAggregate: { items: ["REQUESTED", "CANCELLED"], expectedBySystemSpec: "IN_PROGRESS", actual: aggregateRequestStatus([{ status: "REQUESTED" }, { status: "CANCELLED" }]) }
}, null, 2));
