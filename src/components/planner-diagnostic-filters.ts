"use client";

import type { HospitalPlanView, PlannerViewFilters, SessionUser } from "@cvg/contracts";
import { useCallback, useMemo } from "react";
import { matchesDiagnosticPlannerFilters } from "@cvg/shared-state";
import { usePlannerResource } from "./use-planner-resource";
import type { WorkItem } from "./work-items/model";

/** Revalidates plan membership separately from the authorized diagnostic feed. */
export function usePlannerDiagnosticFilters(user: SessionUser | null | undefined, filters: PlannerViewFilters) {
  const enabled = Boolean(filters.planId && user?.permissions?.includes("plan.view"));
  const plan = usePlannerResource<HospitalPlanView>(user?.id, `/hospital-plans/${encodeURIComponent(filters.planId ?? "")}`, enabled);
  const unavailable = Boolean(filters.planId && (!enabled || plan.loading || plan.error || !plan.data));
  const error = filters.planId && !enabled ? "Esta visão exige acesso atual ao plano. Nenhum exame é exibido até selecionar uma visão compatível." : plan.error;
  const ids = useMemo(() => new Set(plan.data?.activities.filter(entry => entry.targetType === "DIAGNOSTIC_ITEM").map(entry => entry.targetId)), [plan.data]);
  const matches = useCallback((item: WorkItem) => !unavailable && matchesDiagnosticPlannerFilters(item, filters, ids.has(item.id)), [unavailable, filters, ids]);
  return {
    error, loading: enabled && plan.loading, unavailable, reload: plan.reload,
    matches
  };
}
