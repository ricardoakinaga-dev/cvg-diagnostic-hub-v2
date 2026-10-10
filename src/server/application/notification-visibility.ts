import type { Notification, StoreState, User } from "../domain/models";
import { canAccessResource } from "../security/authorization";
import { canViewRequest, criticalResultResource, requestForNotification } from "./service-common";

/**
 * A notification names the patient and leads into the record, so it is shown only while its recipient can
 * still open what it points to: the result for a result notification, the request otherwise. Revalidated on
 * every read; a reduced scope hides it, a restored one shows it again. An ADMINISTRATIVE notification is
 * operational (for instance, a critical result nobody could be reached for): it must never carry patient data,
 * so it does not depend on clinical scope.
 */
export function canViewNotification(state: StoreState, actor: User, notification: Notification): boolean {
  if (notification.category === "ADMINISTRATIVE") return true;
  if (notification.entityType === "RESULT_VERSION") {
    const resource = criticalResultResource(state, notification);
    return Boolean(resource && canAccessResource(actor, "result.view", resource));
  }
  const request = requestForNotification(state, notification);
  return Boolean(request && canViewRequest(state, actor, request));
}
