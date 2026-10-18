"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { HospitalTaskState, HospitalTaskType } from "@cvg/contracts";
import { HOSPITAL_TASK_PHASES } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { usePlannerIdentity } from "./use-planner";
import { usePlannerCommand } from "./planner-command";
import { ErrorState, LoadingState } from "./feedback-states";
import { PHASE_LABELS } from "./planner-model";

const newStates = (): HospitalTaskState[] => HOSPITAL_TASK_PHASES.map((phase) => ({ code: phase, label: PHASE_LABELS[phase], phase }));
export function PlannerTaskTypes() {
  const { user, error } = usePlannerIdentity(); const [types, setTypes] = useState<HospitalTaskType[]>([]); const [readError, setReadError] = useState(""); const [reload, setReload] = useState(0);
  const mayManage = user?.permissions?.includes("hospital_task_type.manage") === true;
  useEffect(() => {
    if (!mayManage) return; const controller = new AbortController();
    void apiFetch<HospitalTaskType[]>("/hospital-task-types", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setTypes(result); setReadError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setTypes([]); setReadError(getSafeErrorMessage(cause, "Não foi possível carregar os tipos.")); } }); return () => controller.abort();
  }, [user?.id, mayManage, reload]);
  if (error) return <ErrorState page title="Tipos indisponíveis" message={error} onRetry={() => window.location.reload()} />;
  if (!user) return <LoadingState label="Carregando tipos de atividade" />;
  if (!mayManage) return <ErrorState page title="Gestão de tipos fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={() => window.location.reload()} />;
  return <div className="detail-page"><Link href="/planner" className="back-link">Voltar ao planner</Link><h1>Tipos e estados de atividades hospitalares</h1><p className="page-lede">Estados próprios para tarefas gerais. Os fluxos diagnósticos continuam usando seus comandos clínicos.</p>{readError && <ErrorState message={readError} onRetry={() => setReload((value) => value + 1)} />}<TaskTypeForm key={`${user.id}:new`} onSaved={() => setReload((value) => value + 1)} />{types.map((type) => <TaskTypeForm key={`${user.id}:${type.id}:${type.version}`} type={type} onSaved={() => setReload((value) => value + 1)} />)}</div>;
}
function TaskTypeForm({ type, onSaved }: { type?: HospitalTaskType; onSaved: () => void }) {
  const [code, setCode] = useState(type?.code ?? ""); const [name, setName] = useState(type?.name ?? ""); const [care, setCare] = useState(type?.careContextRequired ?? false); const [states, setStates] = useState(type?.states ?? newStates()); const command = usePlannerCommand();
  function update(index: number, patch: Partial<HospitalTaskState>) { setStates((previous) => previous.map((state, current) => current === index ? { ...state, ...patch } : state)); }
  async function save() {
    const result = await command.execute<HospitalTaskType>(type ? `/hospital-task-types/${type.id}` : "/hospital-task-types", type ? "PATCH" : "POST", { ...(type ? { expectedVersion: type.version } : { code: code.trim().toUpperCase() }), name: name.trim(), careContextRequired: care, states });
    if (result) { if (!type) { setCode(""); setName(""); setStates(newStates()); } onSaved(); }
  }
  return <section className="panel"><h2>{type ? `${type.name} · ${type.active ? "Ativo" : "Inativo"}` : "Novo tipo de atividade"}</h2><form aria-label={type ? `Editar tipo ${type.name}` : "Criar tipo de atividade"} onSubmit={(event) => { event.preventDefault(); void save(); }}>{type ? <p>Código permanente: {type.code} · versão {type.version}. Tarefas existentes conservam seus estados originais.</p> : <label>Código do tipo<input required pattern="[A-Za-z][A-Za-z0-9_]+" minLength={2} maxLength={40} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>}<label>Nome do tipo<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label><label><input type="checkbox" checked={care} onChange={(event) => setCare(event.target.checked)} />Exige paciente e atendimento aberto</label>
    <fieldset><legend>Estados por fase</legend>{states.map((state, index) => <div key={index}><label>Código do estado {index + 1}<input required pattern="[A-Z][A-Z0-9_]+" minLength={2} maxLength={40} value={state.code} onChange={(event) => update(index, { code: event.target.value.toUpperCase() })} /></label><label>Nome do estado {index + 1}<input required maxLength={80} value={state.label} onChange={(event) => update(index, { label: event.target.value })} /></label><label>Fase do estado {index + 1}<select value={state.phase} onChange={(event) => update(index, { phase: event.target.value as typeof state.phase })}>{HOSPITAL_TASK_PHASES.map((phase) => <option key={phase} value={phase}>{PHASE_LABELS[phase]}</option>)}</select></label><button type="button" disabled={command.busy || states.length <= 4} onClick={() => setStates((previous) => previous.filter((_, current) => current !== index))}>Remover estado {index + 1}</button></div>)}</fieldset><p className="field-hint">Defina ao menos um estado para cada fase. Códigos devem ser distintos.</p><button type="button" disabled={command.busy || states.length >= 20} onClick={() => setStates((previous) => [...previous, { code: "", label: "", phase: "PENDING" }])}>Adicionar estado</button><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>{type ? "Salvar tipo" : "Criar tipo"}</ActionButton>
    </form>{type && <ActionButton tone="ghost" state={command.busy ? "pending" : "idle"} onClick={() => { void command.execute(`/hospital-task-types/${type.id}`, "PATCH", { active: !type.active, expectedVersion: type.version }).then((result) => { if (result) onSaved(); }); }}>{type.active ? "Inativar tipo" : "Reativar tipo"}</ActionButton>}{command.error && <p role="alert">{command.error}</p>}</section>;
}
