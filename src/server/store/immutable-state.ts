import type { StoreState } from "../domain/models";

/**
 * Read paths share one frozen aggregate instead of cloning it on every call.
 *
 * The clone cost grew with the whole clinical history: the 2026-10-07 audit
 * measured ~10 s for one list request at six months of data. Freezing turns an
 * accidental in-place mutation into a TypeError instead of a silent corruption
 * of the shared cache. Objects that are already frozen are skipped, so a write
 * only pays for the entities and arrays it replaced (structural sharing).
 */
export function freezeState(state: StoreState): StoreState {
  deepFreeze(state);
  return state;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) deepFreeze(value[index]);
    return;
  }
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) deepFreeze((value as Record<string, unknown>)[key]);
  }
}
