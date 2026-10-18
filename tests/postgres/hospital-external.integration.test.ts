import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import type { ApplicationServiceContext } from "../../src/server/application/service-context";
import { createHospitalIntegrationService } from "../../src/server/application/hospital-integration-service";
import { externalConfig, EXTERNAL_SECRET } from "../../src/test/hospital-external-fixtures";

describe("signed hospital ingress on isolated PostgreSQL", () => {
  it("serializes two stores and rolls back both native command and receipt on a crash", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("postgres-external-test-only"); const first = await database.createStore(base); const second = await database.createStore();
      const unused = async (): Promise<never> => { throw new Error("Storage is outside this integration test"); };
      const context = (store: ApplicationServiceContext["store"]): ApplicationServiceContext => ({ store, storage: { put: unused, get: unused, remove: unused, exists: unused }, scanner: { scan: unused }, patientDiagnosticsAuxiliaryReader: ({ state }) => ({ samples: state.samples, results: state.results, attachments: state.attachments }) });
      try {
        const a = createHospitalIntegrationService(context(first), { config: externalConfig }); const b = createHospitalIntegrationService(context(second), { config: externalConfig }); const admin = base.users.find(entry => entry.id === "user-admin")!;
        const issued = await a.createHospitalIntegrationCredential(admin, { system: "HIS", purpose: "HIS_INTAKE", actorUserId: "user-vet", name: "PG test credential", scope: { departmentCodes: ["INPATIENT"] }, ttlSeconds: 300, idempotencyKey: "pg-issue" });
        const incoming = { contract: "CVG_OPERATIONAL_V1", messageId: "pg-ingress-race", externalEntityId: "pg-external-entity", sequence: 1, occurredAt: new Date().toISOString(), purpose: "HIS_INTAKE", payload: { title: "Demanda sintética PG", departmentCode: "INPATIENT", priority: "ROUTINE" } };
        const receive = (service: typeof a, body = incoming) => { const raw = JSON.stringify(body); return service.receiveHospitalIntegrationMessage("HIS", issued.token!, `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(raw).digest("hex")}`, raw); };
        const receipts = await Promise.all([receive(a), receive(b)]); expect(receipts[0]).toEqual(receipts[1]); const after = await second.readState(); expect(after.hospitalIntakes).toHaveLength(1); expect(after.hospitalIntegrationMessages).toHaveLength(1); expect(after.hospitalIntegrationMessages[0].status).toBe("SUCCEEDED");
        let crash = true; const faulty = createHospitalIntegrationService(context(first), { config: externalConfig, afterInboundCommand: async () => { if (crash) throw new Error("Synthetic post-command failure"); } });
        const next = { ...incoming, messageId: "pg-ingress-after-crash", sequence: 2 }; await expect(receive(faulty, next)).rejects.toThrow("Synthetic post-command failure"); const rolledBack = await second.readState(); expect(rolledBack.hospitalIntakes).toEqual(after.hospitalIntakes); expect(rolledBack.hospitalIntegrationMessages).toEqual(after.hospitalIntegrationMessages);
        crash = false; await receive(faulty, next); await receive(b, next); const persisted = await second.readState(); expect(persisted.hospitalIntakes).toHaveLength(2); expect(persisted.hospitalIntegrationMessages).toHaveLength(2);
        expect((await database.query("SELECT data->>'status' AS status FROM cvg_runtime_entities WHERE collection='hospitalIntegrationMessages' ORDER BY position")).rows).toEqual([{ status: "SUCCEEDED" }, { status: "SUCCEEDED" }]);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
