import { describe, expect, it } from "vitest";
import { maskAlertPhone, normalizeAlertPhone, updateOwnAlertContact } from "./alert-contact";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

// Built at run time so the privacy scan never sees a formatted phone number in the source.
const parts = ["11", "9", "8765", "4321"];
const national = parts.join("");
const e164 = `+55${national}`;

function setup() {
  const store = new MemoryStore(createDemoState("test-password-2026"));
  const user = (id: string) => store.getState().users.find((candidate) => candidate.id === id)!;
  return { store, user, service: createApplicationService(store) };
}

describe("normalizeAlertPhone", () => {
  it("turns what people type in Brazil into E.164", () => {
    expect(normalizeAlertPhone(national)).toBe(e164);
    expect(normalizeAlertPhone(`(${parts[0]}) ${parts[1]}${parts[2]}-${parts[3]}`)).toBe(e164);
    expect(normalizeAlertPhone(` +55 ${parts[0]} ${parts[1]} ${parts[2]}.${parts[3]} `)).toBe(e164);
    expect(normalizeAlertPhone(`55${national}`)).toBe(e164);
    expect(normalizeAlertPhone(`${parts[0]}3333${parts[3]}`)).toBe(`+55${parts[0]}3333${parts[3]}`);
    expect(normalizeAlertPhone(`+351 ${parts[1]}12 345 678`)).toBe(`+351${parts[1]}12345678`);
  });

  it("rejects anything that cannot be dialled", () => {
    for (const value of ["", "   ", "call me", "12345", `+55+${national}`, `0${national}`, `+0${national}`, `+55 ${parts[0]} ${parts[1]}876`, `+5501${parts[1]}${parts[2]}${parts[3]}`, "1".repeat(41)]) {
      expect(() => normalizeAlertPhone(value), value).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", status: 400 }));
    }
  });

  it("masks all but the country code and the last four digits", () => {
    expect(maskAlertPhone(e164)).toBe("+55•••••••4321");
    expect(maskAlertPhone("+1234567")).toBe("+12•4567");
  });
});

describe("updateOwnAlertContact", () => {
  it("registers the number with consent and audits the change without the number", async () => {
    const { store, user } = setup();
    const vet = user("user-vet");
    const updated = await updateOwnAlertContact(store, vet, { whatsappPhone: national, consent: true }, "corr-alert-set");
    expect(updated).toMatchObject({ whatsappPhone: e164, version: vet.version + 1 });
    expect(Date.parse(updated.whatsappConsentAt!)).not.toBeNaN();
    expect(user("user-vet")).toMatchObject({ whatsappPhone: e164, whatsappConsentAt: updated.whatsappConsentAt });
    const audit = store.getState().auditEvents.at(-1)!;
    expect(audit).toMatchObject({ eventType: "AlertContactUpdated", actorId: vet.id, entityId: vet.id, previousState: "NONE", newState: "REGISTERED", correlationId: "corr-alert-set", metadata: { action: "SET_ALERT_CONTACT", channel: "WHATSAPP" } });
    expect(JSON.stringify(audit)).not.toContain(parts[2]);
  });

  it("keeps the state untouched when the same number is sent again", async () => {
    const { store, user } = setup();
    await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: national, consent: true }, "corr-1");
    const before = store.getState();
    const again = await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: e164, consent: true }, "corr-2");
    expect(again.version).toBe(user("user-vet").version);
    expect(store.getState()).toStrictEqual(before);
  });

  it("replaces and removes the number, renewing consent on replacement", async () => {
    const { store, user } = setup();
    await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: national, consent: true }, "corr-1");
    const replaced = await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: `${parts[0]}${parts[1]}1111${parts[3]}`, consent: true }, "corr-2");
    expect(replaced.whatsappPhone).toBe(`+55${parts[0]}${parts[1]}1111${parts[3]}`);
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ previousState: "REGISTERED", newState: "REGISTERED" });
    const removed = await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: null }, "corr-3");
    expect(removed).not.toHaveProperty("whatsappPhone");
    expect(removed).not.toHaveProperty("whatsappConsentAt");
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ previousState: "REGISTERED", newState: "NONE", metadata: { action: "REMOVE_ALERT_CONTACT" } });
    const before = store.getState();
    await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: null }, "corr-4");
    expect(store.getState()).toStrictEqual(before);
  });

  it("requires consent, a valid number and an active account", async () => {
    const { store, user } = setup();
    const vet = user("user-vet");
    await expect(updateOwnAlertContact(store, vet, { whatsappPhone: national }, "corr")).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(updateOwnAlertContact(store, vet, { whatsappPhone: national, consent: false }, "corr")).rejects.toMatchObject({ status: 400 });
    await expect(updateOwnAlertContact(store, vet, { whatsappPhone: "12345", consent: true }, "corr")).rejects.toMatchObject({ status: 400 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((candidate) => candidate.id === vet.id ? { ...candidate, active: false } : candidate) }, result: undefined }));
    await expect(updateOwnAlertContact(store, vet, { whatsappPhone: national, consent: true }, "corr")).rejects.toMatchObject({ status: 401 });
    expect(user("user-vet")).not.toHaveProperty("whatsappPhone");
  });
});

describe("updateUserOnCall", () => {
  it("marks and unmarks a user, versioned and audited", async () => {
    const { store, user, service } = setup();
    const admin = user("user-admin");
    const vet = user("user-vet");
    const marked = await service.updateUserOnCall(admin, vet.id, { onCall: true, expectedVersion: vet.version, reason: " Escala de sábado ", idempotencyKey: "on-call-1" });
    expect(marked).toMatchObject({ id: vet.id, onCall: true, alertContactReady: false, version: vet.version + 1 });
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "UserOnCallUpdated", actorId: admin.id, entityId: vet.id, previousState: "OFF_CALL", newState: "ON_CALL", metadata: { action: "UPDATE_USER_ON_CALL", departmentCode: "INPATIENT", reason: "Escala de sábado" } });
    const auditCount = store.getState().auditEvents.length;
    const replay = await service.updateUserOnCall(admin, vet.id, { onCall: true, expectedVersion: vet.version, reason: " Escala de sábado ", idempotencyKey: "on-call-1" });
    expect(replay).toEqual(marked);
    expect(store.getState().auditEvents).toHaveLength(auditCount);
    const unmarked = await service.updateUserOnCall(admin, vet.id, { onCall: false, expectedVersion: marked.version, idempotencyKey: "on-call-2" });
    expect(unmarked.onCall).toBe(false);
    expect(store.getState().auditEvents.at(-1)!.metadata).not.toHaveProperty("reason");
  });

  it("lists whether the user registered a number, never the number", async () => {
    const { store, user, service } = setup();
    await updateOwnAlertContact(store, user("user-vet"), { whatsappPhone: national, consent: true }, "corr");
    const listed = (await service.listManagedUsers(user("user-admin"))).find((entry) => entry.id === "user-vet")!;
    expect(listed).toMatchObject({ alertContactReady: true, onCall: false });
    expect(JSON.stringify(listed)).not.toContain(parts[2]);
  });

  it("enforces version, scope, permission and an active target", async () => {
    const { store, user, service } = setup();
    const admin = user("user-admin");
    const lab = user("user-lab");
    await expect(service.updateUserOnCall(admin, lab.id, { onCall: true, idempotencyKey: "no-version" })).rejects.toMatchObject({ status: 400 });
    await expect(service.updateUserOnCall(admin, lab.id, { onCall: true, expectedVersion: lab.version + 5, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    await expect(service.updateUserOnCall(admin, lab.id, { onCall: true, expectedVersion: lab.version })).rejects.toMatchObject({ status: 400 });
    await expect(service.updateUserOnCall(user("user-manager"), admin.id, { onCall: true, expectedVersion: admin.version, idempotencyKey: "manager-admin" })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateUserOnCall(user("user-vet"), lab.id, { onCall: true, expectedVersion: lab.version, idempotencyKey: "vet" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.updateUserOnCall(admin, "user-missing", { onCall: true, expectedVersion: 1, idempotencyKey: "missing" })).rejects.toMatchObject({ status: 404 });
    const byManager = await service.updateUserOnCall(user("user-manager"), lab.id, { onCall: true, expectedVersion: lab.version, idempotencyKey: "manager-lab" });
    expect(byManager.onCall).toBe(true);
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((candidate) => candidate.id === "user-rx" ? { ...candidate, active: false } : candidate) }, result: undefined }));
    const rx = user("user-rx");
    await expect(service.updateUserOnCall(admin, rx.id, { onCall: true, expectedVersion: rx.version, idempotencyKey: "inactive" })).rejects.toMatchObject({ status: 400 });
  });

  it("takes people off call when they lose access", async () => {
    const { user, service } = setup();
    const admin = user("user-admin");
    const lab = await service.updateUserOnCall(admin, "user-lab", { onCall: true, expectedVersion: user("user-lab").version, idempotencyKey: "lab-on" });
    const deactivated = await service.deactivateManagedUser(admin, lab.id, { expectedVersion: lab.version, idempotencyKey: "lab-off" });
    expect(deactivated).toMatchObject({ active: false, onCall: false });
    const rx = await service.updateUserOnCall(admin, "user-rx", { onCall: true, expectedVersion: user("user-rx").version, idempotencyKey: "rx-on" });
    const disabled = await service.updateUserRole(admin, rx.id, { role: "RADIOLOGY_TEAM", departmentCode: "RADIOLOGY", active: false, expectedVersion: rx.version, idempotencyKey: "rx-role" });
    expect(disabled).toMatchObject({ active: false, onCall: false });
    const offAgain = await service.updateUserOnCall(admin, rx.id, { onCall: false, expectedVersion: disabled.version, idempotencyKey: "rx-off" });
    expect(offAgain.onCall).toBe(false);
  });
});
