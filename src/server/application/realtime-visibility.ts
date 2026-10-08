import type { StoreState, User } from "../domain/models";
import { canViewItem, canViewRequest } from "./service-common";
import { findById } from "../domain/state-index";

/** Events expose only aggregate metadata; resolve their scope from current state. */
export function eventVisible(state: StoreState, actor: User, entityType: string, entityId: string, _payload: Record<string, unknown>): boolean {
  const itemVisible = (itemId: string | undefined) => {
    const item = findById(state.items, itemId);
    return Boolean(item && canViewItem(state, actor, item));
  };
  const resultVisible = (resultId: string | undefined) => itemVisible(findById(state.results, resultId)?.itemId);
  switch (entityType) {
    case "DiagnosticRequest": {
      const request = findById(state.requests, entityId);
      return Boolean(request && canViewRequest(state, actor, request));
    }
    case "DiagnosticRequestItem":
      return itemVisible(entityId);
    case "Sample":
      return findById(state.samples, entityId)?.itemIds.some(itemVisible) ?? false;
    case "Result":
      return resultVisible(entityId);
    case "Procedure":
      return itemVisible(findById(state.procedures, entityId)?.itemId);
    case "Attachment": {
      const versionId = findById(state.attachments, entityId)?.resultVersionId;
      return resultVisible(findById(state.resultVersions, versionId)?.resultId);
    }
    case "ResultVersion":
      return resultVisible(findById(state.resultVersions, entityId)?.resultId);
    default:
      return false;
  }
}
