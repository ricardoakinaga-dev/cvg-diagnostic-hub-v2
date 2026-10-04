import type { StateStore, User } from "../domain/models";
import { canAccessResource } from "../security/authorization";
import { requireActiveUser } from "./service-common";

/** Read clinical labels without granting catalog-administration permissions. */
export async function listClinicalReasons(store: StateStore, actor: User) {
  const state = await store.readState();
  const current = requireActiveUser(state, actor);
  const permissions = { RECOLLECTION: "sample.recollection.request", CANCEL: "item.cancel", REJECT: "item.reject", AMEND: "result.amend" } as const;
  return state.reasonCodes
    .filter((reason) => reason.active && canAccessResource(current, permissions[reason.type], { departmentCode: current.departmentCode }))
    .map(({ id, type, code, label, active, version }) => ({ id, type, code, label, active, version }));
}
