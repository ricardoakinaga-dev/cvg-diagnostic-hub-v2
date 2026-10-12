import { createDemoState } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";
import { createApplicationService } from "../server/application/service";
import type { ApplicationServiceContext } from "../server/application/service-context";
import type { HospitalIntegrationHttpConfig } from "../server/application/hospital-integration-http";
import type { HospitalDocumentContent, HospitalIntegrationSystem } from "@cvg/contracts";
export const EXTERNAL_NOW = "2026-10-11T18:00:00.000Z";
export const EXTERNAL_SECRET = "synthetic-test-only-secret-32-bytes-minimum";
export const externalConfig = (system: HospitalIntegrationSystem): HospitalIntegrationHttpConfig => ({ system, endpoint: "https://vendor.example.test/cvg/v1", allowedHosts: ["vendor.example.test"], allowedIps: ["127.0.0.1"], bearerToken: EXTERNAL_SECRET, hmacSecret: EXTERNAL_SECRET, contractReference: "synthetic-test-only-contract", timeoutMs: 1000 });
export const rich = (text: string): HospitalDocumentContent => ({ type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text }] }] });
export function hospitalExternalFixture() {
  const store = new MemoryStore(createDemoState("synthetic-external-test-only-password"));
  const unused = async (): Promise<never> => { throw new Error("Storage is outside this test's contract"); };
  const context: ApplicationServiceContext = { store, storage: { put: unused, get: unused, remove: unused, exists: unused }, scanner: { scan: unused }, patientDiagnosticsAuxiliaryReader: ({ state }) => ({ samples: state.samples, results: state.results, attachments: state.attachments }) };
  const service = createApplicationService(store, { storage: context.storage }); const user = (id: string) => store.getState().users.find(entry => entry.id === id)!;
  const document = () => service.createHospitalDocument(user("user-admin"), { code: "EXTERNAL_DOC", title: "Documento sintético", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Original"), idempotencyKey: "doc" });
  return { store, context, service, user, document };
}
