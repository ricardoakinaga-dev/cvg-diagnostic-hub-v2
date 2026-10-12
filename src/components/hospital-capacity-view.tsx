"use client";

import Link from "next/link";
import { useState } from "react";
import type { HospitalCapacityView as CapacityView } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { usePlannerIdentity } from "./use-planner";
import { usePlannerResource } from "./use-planner-resource";
import { useDepartments } from "./use-departments";
import { defaultPlannerPeriod, PlannerPeriodFields } from "./planner-period";
import { HospitalCapacityPanel } from "./hospital-capacity-panel";

export function HospitalCapacityView() {
  const { user, error } = usePlannerIdentity(); const directory = useDepartments(user?.id); const [draft, setDraft] = useState(defaultPlannerPeriod); const [period, setPeriod] = useState(draft); const [department, setDepartment] = useState(""); const [inputError, setInputError] = useState("");
  const mayRead = user?.permissions?.includes("hospital_capacity.view") === true;
  const resource = usePlannerResource<CapacityView>(user?.id, `/hospital-capacity?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}${department ? `&departmentCode=${encodeURIComponent(department)}` : ""}`, mayRead);
  if (error) return <ErrorState page title="Capacidade indisponível" message={error} onRetry={() => window.location.reload()} />;
  if (!user) return <LoadingState label="Carregando capacidade" />;
  if (!mayRead) return <ErrorState page title="Capacidade fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={resource.reload} />;
  const departments = new Map(directory.departments.map((entry) => [entry.code, entry.name])); for (const entry of resource.data?.resources ?? []) if (!departments.has(entry.departmentCode)) departments.set(entry.departmentCode, entry.departmentCode);
  return <div className="detail-page"><Link href="/planner" className="back-link">Voltar ao planner</Link><h1>Capacidade e prazos</h1><p className="page-lede">Capacidade é a disponibilidade cadastrada no período. Carga autorizada e prazo clínico têm medidas distintas.</p><form className="panel" aria-label="Filtrar capacidade" onSubmit={(event) => { event.preventDefault(); if (draft.from >= draft.to) { setInputError("O fim do período deve ocorrer depois do início."); return; } setInputError(""); setPeriod(draft); }}><PlannerPeriodFields value={draft} onChange={setDraft} /><label>Setor da capacidade<select value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">Todos os setores autorizados</option>{[...departments].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label><ActionButton type="submit">Aplicar período</ActionButton>{inputError && <p role="alert">{inputError}</p>}</form>{resource.error && <PartialNotice message={resource.error} onRetry={resource.reload} />}
    {resource.loading && !resource.data && <LoadingState label="Calculando capacidade autorizada" />}{resource.data && <HospitalCapacityPanel data={resource.data} />}
  </div>;
}
