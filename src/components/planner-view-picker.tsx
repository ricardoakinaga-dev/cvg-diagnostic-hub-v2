"use client";

import type { PlannerViewFilters, SavedPlannerView, SessionUser } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { normalizePlannerFilters, PHASE_LABELS } from "./planner-model";
import { usePlannerResource } from "./use-planner-resource";

const filterLabels: Record<keyof PlannerViewFilters, string> = { departmentCode: "Setor", responsibleUserId: "Responsável", typeId: "Tipo de atividade hospitalar", priority: "Prioridade", phase: "Fase", from: "Período desde", to: "Período até", planId: "Plano assistencial" };

export function PlannerViewPicker({ user, filters, onApply, diagnosticOnly = false }: { user: SessionUser; filters: PlannerViewFilters; onApply: (filters: PlannerViewFilters) => void; diagnosticOnly?: boolean }) {
  const views = usePlannerResource<SavedPlannerView[]>(user.id, "/planner-views", user.permissions?.includes("planner_view.view") === true);
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== "") as Array<[keyof PlannerViewFilters, string]>;
  if (!user.permissions?.includes("planner_view.view") && !entries.length) return null;
  if (!entries.length && !views.error && !views.data?.some(view => view.active)) return null;
  return <section className="panel" aria-label="Visão salva aplicada">
    {user.permissions?.includes("planner_view.view") && <label>Aplicar visão salva<select value="" disabled={views.loading || Boolean(views.error)} onChange={(event) => { const view = views.data?.find(entry => entry.active && entry.id === event.target.value); if (view) onApply(normalizePlannerFilters(view.filters)); }}><option value="">Selecione uma visão autorizada…</option>{views.data?.filter(view => view.active).map(view => <option key={view.id} value={view.id}>{view.name}{view.sharedDepartmentCode ? " · Compartilhada" : " · Privada"}</option>)}</select></label>}
    {views.error && <p role="alert">{views.error} <button type="button" onClick={() => void views.reload()}>Recarregar visões salvas</button></p>}
    {entries.length ? <><ul aria-label="Critérios da visão salva">{entries.map(([key, value]) => <li key={key}>{filterLabels[key]}: {key === "from" || key === "to" ? formatHospitalDateTime(value) : key === "phase" ? PHASE_LABELS[value as NonNullable<PlannerViewFilters["phase"]>] : value}</li>)}</ul><button type="button" onClick={() => onApply({})}>Limpar visão salva aplicada</button></> : <p className="field-hint">Nenhum filtro de visão salva aplicado.</p>}
    <p className="field-hint">Compartilhar a configuração mantém o acesso próprio de cada pessoa. Layout, colunas e agrupamento continuam nos controles desta tela; a seleção aplica os filtros.</p>
    {diagnosticOnly && <><p className="field-hint">O responsável é o profissional atribuído. O período usa o início planejado ou a criação do exame; a fase agrupa os estados clínicos sem alterar sua execução.</p>{filters.typeId && <p role="status">Esta visão exige um tipo de atividade hospitalar. Exames não possuem esse tipo e não correspondem ao filtro.</p>}</>}
  </section>;
}
