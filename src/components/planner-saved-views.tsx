"use client";

import { useEffect, useState } from "react";
import type { Department, PlannerViewDisplay, PlannerViewFilters, SavedPlannerView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { usePlannerCommand } from "./planner-command";
import { WorkActivityDisclosure } from "./work-activity-controls";
import { PlannerTargetReference } from "./planner-target-reference";
import { useConfirm } from "./confirm-dialog";

export function PlannerSavedViews({ user, filters, display, departments, onApply }: { user: SessionUser; filters: PlannerViewFilters; display: PlannerViewDisplay; departments: Department[]; onApply: (view: SavedPlannerView) => void }) {
  const [views, setViews] = useState<SavedPlannerView[]>([]); const [error, setError] = useState(""); const [name, setName] = useState(""); const [share, setShare] = useState(""); const [reload, setReload] = useState(0);
  const command = usePlannerCommand(); const confirm = useConfirm(); const permissions = user.permissions ?? [];
  useEffect(() => {
    if (!user.permissions?.includes("planner_view.view")) return;
    const controller = new AbortController();
    void apiFetch<SavedPlannerView[]>("/planner-views", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setViews(result.filter((view) => view.active)); setError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setViews([]); setError(getSafeErrorMessage(cause, "Não foi possível consultar as visões salvas.")); } });
    return () => controller.abort();
  }, [user.id, user.permissions, reload]);
  async function save() {
    if (!permissions.includes("planner_view.create") || !name.trim()) return;
    if (await command.execute<SavedPlannerView>("/planner-views", "POST", { name: name.trim(), filters, display, ...(share && permissions.includes("planner_view.share") ? { sharedDepartmentCode: share } : {}) })) { setName(""); setReload((value) => value + 1); }
  }
  async function deactivate(view: SavedPlannerView) {
    if (view.ownerId !== user.id || !permissions.includes("planner_view.deactivate")) return;
    if (await confirm.confirm({ title: `Desativar visão ${view.name}?`, message: "A configuração deixará de aparecer entre as visões ativas.", confirmLabel: "Desativar visão" })) if (await command.execute(`/planner-views/${view.id}/deactivate`, "POST", { expectedVersion: view.version })) setReload((value) => value + 1);
  }
  if (!permissions.includes("planner_view.view") && !permissions.includes("planner_view.create")) return null;
  return <details className="panel"><summary>Visões salvas</summary><p className="field-hint">Compartilhar uma visão compartilha somente a configuração. Cada pessoa continua vendo os dados do seu próprio acesso.</p>
    <PlannerTargetReference userId={user.id} parameter="viewId" prefix="planner-view-" ids={views.map((view) => view.id)} error={error} onTarget={(id) => { const view = views.find((entry) => entry.id === id); if (view) onApply(view); }} />
    {error && <p role="alert">{error}</p>}{command.error && <p role="alert">{command.error}</p>}
    <ul aria-label="Visões disponíveis">{views.map((view) => <li key={view.id} id={`planner-view-${view.id}`} tabIndex={-1}><button type="button" className="button button-ghost" onClick={() => onApply(view)}>{view.name}</button> · {view.sharedDepartmentCode ? `Compartilhada · ${view.sharedDepartmentCode}` : "Privada"}
      {view.ownerId === user.id && permissions.includes("planner_view.update") && <ActionButton tone="ghost" state={command.busy ? "pending" : "idle"} onClick={() => { void command.execute(`/planner-views/${view.id}`, "PATCH", { filters, display, expectedVersion: view.version }).then((result) => { if (result) setReload((value) => value + 1); }); }}>Atualizar com esta configuração</ActionButton>}
      {view.ownerId === user.id && permissions.includes("planner_view.update") && <ViewIdentityEditor key={`${view.id}:${view.version}`} view={view} mayShare={permissions.includes("planner_view.share")} departments={departments} onSaved={() => setReload((value) => value + 1)} />}
      {view.ownerId === user.id && permissions.includes("planner_view.deactivate") && <button type="button" disabled={command.busy} onClick={() => void deactivate(view)}>Desativar {view.name}</button>}
      <WorkActivityDisclosure user={user} targetType="SAVED_PLANNER_VIEW" targetId={view.id} readOnly={Boolean(error)} />
    </li>)}</ul>
    {permissions.includes("planner_view.create") && <form aria-label="Salvar visão do planner" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Nome da visão<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>{permissions.includes("planner_view.share") && <label>Visibilidade<select value={share} onChange={(event) => setShare(event.target.value)}><option value="">Privada</option>{departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>Compartilhada · {department.name}</option>)}</select></label>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar visão atual</ActionButton></form>}
    {confirm.dialog}
  </details>;
}

function ViewIdentityEditor({ view, mayShare, departments, onSaved }: { view: SavedPlannerView; mayShare: boolean; departments: Department[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(view.name); const [share, setShare] = useState(view.sharedDepartmentCode ?? ""); const command = usePlannerCommand();
  async function save() {
    if (!name.trim()) return;
    const result = await command.execute(`/planner-views/${encodeURIComponent(view.id)}`, "PATCH", { name: name.trim(), ...(mayShare && share !== (view.sharedDepartmentCode ?? "") ? { sharedDepartmentCode: share || null } : {}), expectedVersion: view.version });
    if (result) onSaved();
  }
  return <><button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Editar nome e visibilidade de {view.name}</button>{open && <form aria-label={`Editar visão ${view.name}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label>Novo nome da visão<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>{mayShare && <label>Nova visibilidade<select value={share} onChange={(event) => setShare(event.target.value)}><option value="">Privada</option>{departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>Compartilhada · {department.name}</option>)}{share && !departments.some((department) => department.code === share && department.active) && <option value={share} disabled>Compartilhamento existente · {share}</option>}</select></label>}
    {command.error && <p role="alert">{command.error}</p>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar nome e visibilidade</ActionButton>
  </form>}</>;
}
