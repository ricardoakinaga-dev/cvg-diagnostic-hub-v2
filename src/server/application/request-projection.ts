import type { StoreState, User } from "../domain/models";
import type { RequestView } from "./service-types";
import { requestFor, requestViewForActor } from "./service-common";

/**
 * Idempotency preserves the command result, not an authorization grant. A
 * replay must rebuild the actor-scoped request projection after delegation
 * changes, while preserving the committed entities in the cached response.
 */
export function reprojectRequestForActor(state: StoreState, actor: User, requestId: string): RequestView {
  return requestViewForActor(state, actor, requestFor(state, requestId));
}

export function reprojectCommandRequest<T extends { request: RequestView }>(state: StoreState, actor: User, response: T): T {
  return { ...response, request: reprojectRequestForActor(state, actor, response.request.id) };
}
