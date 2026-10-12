"use client";

import type { HospitalPlanView, HospitalShiftView, SessionUser } from "@cvg/contracts";
import { usePlannerPage } from "./use-planner";
import { PartialNotice } from "./feedback-states";

export function PlannerScopeFilters({ user, planId, onPlanChange, shiftId, onShiftChange }: { user: SessionUser; planId?: string; onPlanChange: (id: string | undefined) => void; shiftId?: string; onShiftChange?: (id: string | undefined) => void }) {
  const plans = usePlannerPage<HospitalPlanView>(user.id, "/hospital-plans?limit=50", user.permissions?.includes("plan.view"));
  const shifts = usePlannerPage<HospitalShiftView>(user.id, "/hospital-shifts?limit=50", Boolean(onShiftChange) && user.permissions?.includes("shift.view") === true);
  return <>{(user.permissions?.includes("plan.view") || planId) && <><label>Plano assistencial<select value={planId ?? ""} onChange={(event) => onPlanChange(event.target.value || undefined)}><option value="">Todos os planos e atividades sem plano</option>{plans.items.map(({ plan }) => <option key={plan.id} value={plan.id}>{plan.title} · {plan.code}</option>)}{planId && !plans.items.some(({ plan }) => plan.id === planId) && <option disabled value={planId}>Plano configurado fora das opções atuais</option>}</select></label>{plans.error && <PartialNotice message={plans.error} onRetry={plans.reload} />}{plans.nextCursor && <button type="button" disabled={plans.loadingMore} onClick={() => void plans.loadMore()}>Mais planos para filtrar</button>}</>}
    {onShiftChange && (user.permissions?.includes("shift.view") || shiftId) && <><label>Plantão da atividade<select value={shiftId ?? ""} onChange={(event) => onShiftChange(event.target.value || undefined)}><option value="">Todos os plantões e atividades sem plantão</option>{shifts.items.map(({ shift }) => <option key={shift.id} value={shift.id}>{shift.name} · {shift.code}</option>)}{shiftId && !shifts.items.some(({ shift }) => shift.id === shiftId) && <option disabled value={shiftId}>Plantão configurado fora das opções atuais</option>}</select></label>{shifts.error && <PartialNotice message={shifts.error} onRetry={shifts.reload} />}{shifts.nextCursor && <button type="button" disabled={shifts.loadingMore} onClick={() => void shifts.loadMore()}>Mais plantões para filtrar</button>}</>}
  </>;
}
