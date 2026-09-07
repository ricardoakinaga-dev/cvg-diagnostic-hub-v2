import type { StoreState, User } from "../domain/models";
import { canViewItem, canViewRequest } from "./service-common";

/** Events expose only aggregate metadata; resolve their scope from current state. */
export function eventVisible(state: StoreState, actor: User, entityType: string, entityId: string, _payload: Record<string, unknown>): boolean {
  const itemVisible = (itemId: string | undefined) => {
    const item = state.items.find((entry) => entry.id === itemId);
    return Boolean(item && canViewItem(state, actor, item));
  };
  const resultVisible = (resultId: string | undefined) => itemVisible(state.results.find((entry) => entry.id === resultId)?.itemId);
  switch (entityType) {
    case "DiagnosticRequest": {
      const request = state.requests.find((entry) => entry.id === entityId);
      return Boolean(request && canViewRequest(state, actor, request));
    }
    case "DiagnosticRequestItem":
      return itemVisible(entityId);
    case "Sample":
      return state.samples.find((entry) => entry.id === entityId)?.itemIds.some(itemVisible) ?? false;
    case "Result":
      return resultVisible(entityId);
    case "Procedure":
      return itemVisible(state.procedures.find((entry) => entry.id === entityId)?.itemId);
    case "Attachment": {
      const versionId = state.attachments.find((entry) => entry.id === entityId)?.resultVersionId;
      return resultVisible(state.resultVersions.find((entry) => entry.id === versionId)?.resultId);
    }
    case "ResultVersion":
      return resultVisible(state.resultVersions.find((entry) => entry.id === entityId)?.resultId);
    default:
      return false;
  }
}
