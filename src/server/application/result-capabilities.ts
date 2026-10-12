import type { Permission } from "@cvg/contracts";
import type { User } from "../domain/models";
import { canAccessResource, rolePermissions } from "../security/authorization";
import type { ResultView } from "./service-types";

/** UI hints use the same scope decision as commands; commands still reauthorize every request. */
export function resultCapabilities(actor: User, view: ResultView): Permission[] {
  const resource = {
    patientId: view.request.patientId,
    departmentCode: view.service.departmentCode,
    serviceCode: view.service.code,
    ownerId: view.version.authorId
  };
  return rolePermissions[actor.role].filter((permission) => {
    if (!canAccessResource(actor, permission, resource)) return false;
    if (["result.amend", "result.void"].includes(permission)
      && ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(actor.role)
      && view.version.authorId !== actor.id) return false;
    return true;
  });
}
