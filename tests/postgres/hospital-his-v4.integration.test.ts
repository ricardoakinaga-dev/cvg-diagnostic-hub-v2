import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import type { ApplicationServiceContext } from "../../src/server/application/service-context";
import { createHospitalIntegrationService } from "../../src/server/application/hospital-integration-service";
import { createHospitalHisV4Service } from "../../src/server/application/hospital-his-v4-service";
import { hisV4Config, hisV4Event, hisV4Signed } from "../../src/test/hospital-his-v4-fixtures";

describe("HIS v4 webhook receipts on isolated PostgreSQL", () => {
  it("rolls back intake/receipt together and deduplicates two stores plus new delivery IDs by provider event identity", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-pg-his-v4-password"); const first = await database.createStore(base); const second = await database.createStore();
      const unused = async (): Promise<never> => { throw new Error("Storage outside this test"); }; const context = (store: ApplicationServiceContext["store"]): ApplicationServiceContext => ({ store, storage: { put: unused, get: unused, remove: unused, exists: unused }, scanner: { scan: unused }, patientDiagnosticsAuxiliaryReader: ({ state }) => ({ samples: state.samples, results: state.results, attachments: state.attachments }) });
      try {
        const config = hisV4Config(); const credentialService = createHospitalIntegrationService(context(first), { config: () => undefined, hisV4Config: () => config }); const issued = await credentialService.createHospitalIntegrationCredential(base.users.find(user => user.id === "user-admin")!, { profile: "HIS_V4", system: "HIS", purpose: "HIS_INTAKE", actorUserId: "user-vet", name: "PG isolated V4", scope: { departmentCodes: ["INPATIENT"], patientIds: ["patient-thor"] }, ttlSeconds: 300, idempotencyKey: "his-v4-pg-issue" }); config.webhook!.credentialId = issued.credential.id;
        const raw = JSON.stringify(hisV4Event()); const faulty = createHospitalHisV4Service(context(first), { config: () => config, afterCommand: async () => { throw new Error("Synthetic crash after intake"); } }); const before = await second.readState(); await expect(faulty.receiveHospitalHisV4Webhook(issued.credential.id, hisV4Signed(raw), raw)).rejects.toThrow("Synthetic crash after intake"); const rolledBack = await second.readState(); expect(rolledBack.hospitalIntakes).toEqual(before.hospitalIntakes); expect(rolledBack.hospitalHisV4Deliveries).toEqual(before.hospitalHisV4Deliveries); expect(rolledBack.idempotency).toEqual(before.idempotency);
        const a = createHospitalHisV4Service(context(first), { config: () => config }); const b = createHospitalHisV4Service(context(second), { config: () => config }); const result = await Promise.all([a.receiveHospitalHisV4Webhook(issued.credential.id, hisV4Signed(raw, "pg_delivery_a"), raw), b.receiveHospitalHisV4Webhook(issued.credential.id, hisV4Signed(raw, "pg_delivery_b"), raw)]); expect(result[0]).toEqual(result[1]); expect(await b.receiveHospitalHisV4Webhook(issued.credential.id, hisV4Signed(raw, "pg_delivery_c"), raw)).toEqual(result[0]);
        config.webhook!.webhookId = "recreated_pg_webhook"; expect(await b.receiveHospitalHisV4Webhook(issued.credential.id, { ...hisV4Signed(raw, "pg_delivery_d"), webhookId: "recreated_pg_webhook" }, raw)).toEqual(result[0]); const persisted = await second.readState(); expect(persisted.hospitalIntakes).toHaveLength(1); expect(persisted.hospitalIntakes[0].state).toBe("RECEIVED"); expect(persisted.hospitalHisV4Deliveries).toHaveLength(1); expect((await database.query("SELECT count(*)::int AS count FROM cvg_runtime_entities WHERE collection='hospitalHisV4Deliveries'")).rows).toEqual([{ count: 1 }]);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
