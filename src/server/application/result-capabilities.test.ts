import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { resultCapabilities } from "./result-capabilities";

async function draftFixture() {
  const f = hospitalOperationFixture(); const lab = f.user("user-lab");
  const request = await f.service.createRequest(f.user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "capabilities-request" });
  const received = await f.service.receiveSample(lab, [request.items[0].id], { sampleType: "SYNTHETIC", expectedVersion: 1, idempotencyKey: "capabilities-receive" });
  const started = await f.service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "capabilities-start" });
  const draft = await f.service.createResultDraft(lab, request.items[0].id, { narrative: "Laudo sintético para autorização", content: {}, expectedVersion: started.item.version, idempotencyKey: "capabilities-draft" });
  return { ...f, view: await f.service.getResult(lab, draft.result.id), lab };
}

describe("result UI permissions follow command scope and authorship", () => {
  it("shows amendment and void actions only for the eligible technical author", async () => {
    const f = await draftFixture();
    expect(resultCapabilities(f.lab, f.view)).toEqual(expect.arrayContaining(["result.amend", "result.void", "result.draft.edit_own"]));
    const other = { ...f.lab, id: "synthetic-other-lab" };
    const permissions = resultCapabilities(other, f.view);
    expect(permissions).toContain("result.view");
    for (const action of ["result.amend", "result.void", "result.draft.edit_own"]) expect(permissions).not.toContain(action);
  });

  it("does not show actions after group, service, department, patient or active access is withdrawn", async () => {
    const f = await draftFixture();
    for (const actor of [{ ...f.lab, permissions: [] }, { ...f.lab, serviceCodes: [] }, { ...f.lab, departmentCode: "ULTRASOUND" }, { ...f.lab, active: false }, { ...f.user("user-vet"), patientIds: [] }, f.user("user-admin")]) {
      expect(resultCapabilities(actor, f.view)).toEqual([]);
    }
  });
});
