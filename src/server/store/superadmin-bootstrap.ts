import { randomUUID } from "node:crypto";
import type { StateStore } from "../domain/models";
import { checkBreachedPassword } from "../security/password-policy";
import { systemGroupId } from "../security/access-group-policy";
import { createProductionBootstrapState, type ProductionBootstrapInput } from "./production-bootstrap";

/** Offline, one-time provisioning of the first global administrator in an existing installation. */
export async function bootstrapSuperadmin(
  store: StateStore,
  input: ProductionBootstrapInput,
  options: { authorization?: "ALLOW_SUPERADMIN_BOOTSTRAP" } = {},
  now = new Date()
): Promise<{ userId: string; role: "SUPERADMIN"; mustChangePassword: true }> {
  if (options.authorization !== "ALLOW_SUPERADMIN_BOOTSTRAP") throw new Error("SUPERADMIN_BOOTSTRAP_REQUIRES_AUTHORIZATION");
  if (!input.password) throw new Error("SUPERADMIN_BOOTSTRAP_PASSWORD_REQUIRED");
  const candidate = createProductionBootstrapState(input, now).users[0];
  await checkBreachedPassword(input.password);
  return store.transaction((state) => {
    if (state.users.some((user) => user.role === "SUPERADMIN")) throw new Error("SUPERADMIN_ALREADY_PROVISIONED");
    if (!state.users.some((user) => user.role === "ADMIN" && user.active)) throw new Error("SUPERADMIN_BOOTSTRAP_REQUIRES_EXISTING_ADMIN");
    if (state.users.some((user) => user.email.toLowerCase() === candidate.email)) throw new Error("SUPERADMIN_BOOTSTRAP_EMAIL_IN_USE");
    const user = { ...candidate, role: "SUPERADMIN" as const, accessGroupId: systemGroupId("SUPERADMIN"), mustChangePassword: true as const };
    const audit = {
      id: `audit-${randomUUID()}`,
      eventType: "SuperadminBootstrapped",
      entityType: "User",
      entityId: user.id,
      newState: "ACTIVE",
      correlationId: `corr_superadmin_bootstrap_${randomUUID()}`,
      metadata: { role: user.role, source: "offline-bootstrap", departmentCode: user.departmentCode },
      occurredAt: now.toISOString()
    };
    const next = { ...state, users: [...state.users, user], auditEvents: [...state.auditEvents, audit] };
    return { state: next, result: { userId: user.id, role: user.role, mustChangePassword: user.mustChangePassword } };
  });
}
