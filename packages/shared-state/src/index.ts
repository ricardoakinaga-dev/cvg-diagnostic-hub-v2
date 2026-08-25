import type { ItemState } from "@cvg/contracts";

export interface QueueFilterState {
  overdue: boolean;
  status: "ALL" | ItemState;
}

/** UI-only filter serialization; it never mutates or infers clinical state. */
export function buildQueueFilterQuery(filters: QueueFilterState): string {
  const params = new URLSearchParams();
  if (filters.overdue) params.set("overdue", "true");
  if (filters.status !== "ALL") params.set("status", filters.status);
  return params.toString();
}
