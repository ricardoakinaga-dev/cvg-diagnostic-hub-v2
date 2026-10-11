import { describe, expect, it } from "vitest";
import type { RoleCode } from "@cvg/contracts";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

async function setup() {
  const state = createDemoState("clinical-work-visibility-synthetic-password");
  const author = state.users.find((user) => user.role === "VETERINARIAN")!;
  const admin = state.users.find((user) => user.role === "ADMIN")!;
  const readers: User[] = [
    ...(["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"] as const).map((role) => ({ ...admin, id: `reader-${role}`, email: `reader-${role}@cvg.test`, role, patientIds: ["patient-thor"], serviceCodes: [], managedDepartmentCodes: [] })),
    ...([
      ["LAB_TECH", "LABORATORY", "CRP"],
      ["RADIOLOGY_TEAM", "RADIOLOGY", "XRAY_THORAX"],
      ["ULTRASOUND_TEAM", "ULTRASOUND", "ULTRASOUND_ABDOMEN"]
    ] as const).map(([role, departmentCode, serviceCode]) => ({ ...admin, id: `reader-${role}`, email: `reader-${role}@cvg.test`, role, departmentCode, patientIds: [], serviceCodes: [serviceCode], managedDepartmentCodes: [] })),
    { ...admin, id: "reader-MANAGER", email: "reader-MANAGER@cvg.test", role: "MANAGER", patientIds: [], serviceCodes: [], managedDepartmentCodes: ["LABORATORY"] },
    { ...admin, id: "reader-SUPERADMIN", email: "reader-SUPERADMIN@cvg.test", role: "SUPERADMIN", patientIds: [], serviceCodes: [], managedDepartmentCodes: [] }
  ];
  state.users.push(...readers);
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const shared = await service.createRequest(author, {
    patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE",
    items: [{ serviceId: "service-crp" }, { serviceId: "service-xray" }, { serviceId: "service-ultrasound" }]
  }, { idempotencyKey: "visibility-shared-request" });
  const outside = await service.createRequest(author, {
    patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-crp" }]
  }, { idempotencyKey: "visibility-outside-request" });
  return { store, service, author, admin, shared, outside, reader: (role: RoleCode) => readers.find((user) => user.role === role)! };
}

describe("clinical work remains shared inside the current authorized scope", () => {
  it.each(["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"] as const)("lets %s see another professional's examinations for an assigned patient and hides other patients", async (role) => {
    const c = await setup();
    const actor = c.reader(role);
    expect(actor.departmentCode).toBe("IT");
    const page = await c.service.listRequests(actor);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([expect.objectContaining({ id: c.shared.id, requesterId: c.author.id })]);
    expect(page.items[0].items).toHaveLength(3);
    expect(page.items[0].items.every((item) => item.status === "REQUESTED" && item.priority === "ROUTINE")).toBe(true);
    expect((await c.service.getPatientDiagnostics(actor, "patient-thor")).items.map((request) => request.id)).toEqual([c.shared.id]);
    expect((await c.service.listPatients(actor)).map((patient) => patient.id)).toEqual(["patient-thor"]);
    await expect(c.service.getRequest(actor, c.outside.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.getPatientDiagnostics(actor, "patient-mel")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.getItem(actor, c.outside.items[0].id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    if (role !== "VIEWER") {
      await expect(c.service.createRequest(actor, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "unauthorized-duplicate" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    }
  });

  it.each([
    ["LAB_TECH", "LABORATORY", "service-crp", 2],
    ["RADIOLOGY_TEAM", "RADIOLOGY", "service-xray", 1],
    ["ULTRASOUND_TEAM", "ULTRASOUND", "service-ultrasound", 1]
  ] as const)("shows %s only its authorized service work, regardless of the requester", async (role, department, serviceId, count) => {
    const c = await setup();
    const actor = c.reader(role);
    const page = await c.service.listRequests(actor);
    const items = page.items.flatMap((request) => request.items);
    expect(items).toHaveLength(count);
    expect(items.every((item) => item.departmentCode === department && item.serviceId === serviceId)).toBe(true);
    expect(page.items.every((request) => request.requesterId === c.author.id && request.requesterId !== actor.id)).toBe(true);
    expect(await c.service.listQueue(actor, department)).toHaveLength(count);
    const hidden = c.shared.items.find((item) => item.serviceId !== serviceId)!;
    await expect(c.service.getItem(actor, hidden.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("limits a manager in IT to delegated laboratory items without an extra primary-department filter", async () => {
    const c = await setup();
    const actor = c.reader("MANAGER");
    const page = await c.service.listRequests(actor);
    expect(page.total).toBe(2);
    expect(page.items.flatMap((request) => request.items)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: c.shared.items[0].id, departmentCode: "LABORATORY" }),
      expect.objectContaining({ id: c.outside.items[0].id, departmentCode: "LABORATORY" })
    ]));
    expect(page.items.flatMap((request) => request.items)).toHaveLength(2);
    expect((await c.service.getRequest(actor, c.shared.id)).items).toHaveLength(1);
    await expect(c.service.getItem(actor, c.shared.items[1].id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.listQueue(actor, "RADIOLOGY")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("shows SUPERADMIN all authorized active work without requiring authorship or assigned scopes", async () => {
    const c = await setup();
    const actor = c.reader("SUPERADMIN");
    const page = await c.service.listRequests(actor);
    expect(page.total).toBe(2);
    expect(page.items.flatMap((request) => request.items)).toHaveLength(4);
    expect(page.items.every((request) => request.requesterId !== actor.id)).toBe(true);
  });

  it("keeps technical administrators and inactive clinical users out of clinical work", async () => {
    const c = await setup();
    await expect(c.service.listRequests(c.admin)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.getRequest(c.admin, c.shared.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    const actor = c.reader("VETERINARIAN");
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === actor.id ? { ...user, active: false } : user) }, result: undefined }));
    await expect(c.service.listRequests(actor)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});
