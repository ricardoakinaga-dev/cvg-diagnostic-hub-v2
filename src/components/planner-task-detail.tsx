"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HospitalTaskCommand, HospitalTaskType, HospitalTaskView, Permission, PlannerSearchResult, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime, hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { usePlannerIdentity, usePlannerOptions, usePlannerPage } from "./use-planner";
import { usePlannerCommand } from "./planner-command";
import { useDepartments } from "./use-departments";
import { PlannerTaskForm } from "./planner-task-form";
import { PlannerTaskHistory } from "./planner-task-history";
import { HospitalReservationControls } from "./hospital-reservation-controls";
import { HospitalTaskExecution } from "./hospital-task-execution";
import { PlannerContextFields, type PlannerCareContext } from "./planner-context-fields";
import { HospitalTaskReactions } from "./hospital-task-reactions";
import { HospitalTaskComments } from "./hospital-task-comments";
import { HospitalTaskAttachments } from "./hospital-task-attachments";
import { WorkActivityControls } from "./work-activity-controls";
import { PlannerTaskAdvanced } from "./planner-task-advanced";
import { PHASE_LABELS } from "./planner-model";

export function PlannerTaskDetail({ taskId }: { taskId: string }) {
  const { user, error: identityError } = usePlannerIdentity();
  const [resource, setResource] = useState<{ scope: string; view?: HospitalTaskView; error: string; loading: boolean; conflict?: boolean }>({ scope: "", error: "", loading: false });
  const dirty = useRef({ scope: "", changed: false });
  const generation = useRef(0); const scope = `${user?.id ?? ""}:${taskId}`;
  const invalidate = useCallback(() => { generation.current += 1; }, []);
  const mayRead = user?.permissions?.includes("hospital_task.view") === true;
  const load = useCallback(async () => {
    const current = ++generation.current; if (!user || !mayRead) return;
    setResource((previous) => ({ scope, view: previous.scope === scope ? previous.view : undefined, error: "", loading: true, conflict: previous.scope === scope && previous.conflict }));
    try {
      const view = await apiFetch<HospitalTaskView>(`/hospital-tasks/${encodeURIComponent(taskId)}`);
      if (generation.current === current) setResource((previous) => {
        const keepDraft = previous.scope === scope && previous.view && dirty.current.scope === scope && dirty.current.changed && previous.view.task.version < view.task.version && previous.view.task.patientId === view.task.patientId && previous.view.task.encounterId === view.task.encounterId && previous.view.task.departmentCode === view.task.departmentCode;
        return { scope, view: keepDraft ? { ...view, task: { ...view.task, version: previous.view!.task.version } } : previous.scope === scope && previous.view && previous.view.task.version > view.task.version ? previous.view : view, error: "", loading: false, conflict: Boolean(keepDraft) };
      });
    } catch (cause) {
      if (generation.current === current) setResource((previous) => ({ scope, view: cause instanceof ApiClientError && [401, 403, 404].includes(cause.status) ? undefined : previous.scope === scope ? previous.view : undefined, error: getSafeErrorMessage(cause, "Não foi possível consultar a atividade."), loading: false }));
    }
  }, [scope, taskId, user, mayRead]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); const update = () => { void load(); }; window.addEventListener("cvg:realtime-updated", update); window.addEventListener("cvg:realtime-resync", update); return () => { window.clearTimeout(timer); invalidate(); window.removeEventListener("cvg:realtime-updated", update); window.removeEventListener("cvg:realtime-resync", update); }; }, [load, invalidate]);
  const view = resource.scope === scope && mayRead ? resource.view : undefined;
  if (identityError || resource.scope === scope && resource.error && !view) return <ErrorState page title="Atividade indisponível" message={identityError || resource.error} onRetry={load} />;
  if (user && !mayRead) return <ErrorState page title="Atividade fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={load} />;
  if (!user || !view) return <LoadingState label="Carregando atividade hospitalar" />;
  function saved(updated: HospitalTaskView) { dirty.current = { scope, changed: false }; generation.current++; setResource({ scope, view: updated, error: "", loading: false }); }
  return <div className="detail-page"><Link href="/planner" className="back-link">Voltar ao planner</Link>
    {resource.error && <PartialNotice message={resource.error} onRetry={load} />}
    {resource.conflict && <p role="alert">A atividade mudou enquanto você editava. Suas alterações permanecem nesta tela; reconcilie a versão antes de operar. <button type="button" onClick={() => { dirty.current = { scope, changed: false }; void load(); }}>Recarregar e descartar minhas alterações</button></p>}
    <PlannerTaskEditor key={`${user.id}:${view.task.id}:${view.task.version}`} user={user} view={view} readOnly={Boolean(resource.error || resource.conflict)} onDirty={() => { dirty.current = { scope, changed: true }; }} onSaved={saved} />
    {!resource.error && !resource.conflict && <HospitalReservationControls key={`reservation:${user.id}:${view.task.id}:${view.task.version}`} user={user} view={view} onChanged={() => void load()} />}
    <PlannerTaskAdvanced key={`advanced:${user.id}:${view.task.id}:${view.task.version}`} user={user} view={view} readOnly={Boolean(resource.error || resource.conflict)} onDirty={() => { dirty.current = { scope, changed: true }; }} onSaved={saved} />
    <HospitalTaskReactions user={user} view={view} disabled={Boolean(resource.error || resource.conflict)} onChanged={() => void load()} />
    <WorkActivityControls key={`private:${user.id}:${view.task.id}`} user={user} targetType="HOSPITAL_TASK" targetId={view.task.id} readOnly={Boolean(resource.error)} />
    <HospitalTaskComments key={`comments:${user.id}:${view.task.id}`} user={user} view={view} readOnly={Boolean(resource.error || resource.conflict)} />
    <HospitalTaskAttachments key={`attachments:${user.id}:${view.task.id}`} user={user} view={view} readOnly={Boolean(resource.error || resource.conflict)} />
    <PlannerTaskHistory key={`${user.id}:${view.task.id}`} userId={user.id} taskId={view.task.id} />
  </div>;
}

function PlannerTaskEditor({ user, view, readOnly, onDirty, onSaved }: { user: SessionUser; view: HospitalTaskView; readOnly: boolean; onDirty: () => void; onSaved: (view: HospitalTaskView) => void }) {
  const { task } = view; const command = usePlannerCommand();
  const creationOptions = usePlannerOptions(user);
  const directory = useDepartments(user.id, { includeInactive: true });
  const [title, setTitle] = useState(task.title); const [description, setDescription] = useState(task.description ?? "");
  const [start, setStart] = useState(task.plannedStartAt ? hospitalDateTimeInput(task.plannedStartAt) : ""); const [end, setEnd] = useState(task.plannedEndAt ? hospitalDateTimeInput(task.plannedEndAt) : "");
  const [responsible, setResponsible] = useState(task.responsibleUserId ?? ""); const [executors, setExecutors] = useState(task.executorTeamUserIds); const [participants, setParticipants] = useState(task.participantUserIds);
  const [priority, setPriority] = useState(task.priority); const [priorityReason, setPriorityReason] = useState("");
  const [action, setAction] = useState<HospitalTaskCommand>(); const [stateCode, setStateCode] = useState(""); const [note, setNote] = useState(""); const [reason, setReason] = useState("");
  const [inputError, setInputError] = useState(""); const [newChild, setNewChild] = useState(false); const [types, setTypes] = useState<HospitalTaskType[]>([]); const [typesError, setTypesError] = useState("");
  const [context, setContext] = useState<PlannerCareContext>({ patientId: task.patientId, encounterId: task.encounterId });
  const [contextOpen, setContextOpen] = useState(false);
  const [query, setQuery] = useState(""); const [target, setTarget] = useState<PlannerSearchResult>(); const [blocks, setBlocks] = useState<"START" | "COMPLETE">("START");
  const may = (permission: Permission) => view.permissions.includes(permission) && user.permissions?.includes(permission) === true;
  const management = user.role === "MANAGER" || user.role === "SUPERADMIN";
  const directoryName = directory.departments.find((department) => department.code === task.departmentCode)?.name ?? task.departmentCode;
  const search = usePlannerPage<PlannerSearchResult>(user.id, `/planner/search?query=${encodeURIComponent(query.trim())}&types=HOSPITAL_TASK,DIAGNOSTIC_ITEM&limit=25`, may("hospital_task.dependency.manage") && query.trim().length >= 2);
  useEffect(() => {
    if (!newChild) return;
    const controller = new AbortController();
    void apiFetch<HospitalTaskType[]>("/hospital-task-types", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setTypes(result); setTypesError(result.some((type) => type.active) ? "" : "Nenhum tipo ativo disponível para criar uma subtarefa."); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setTypes([]); setTypesError(getSafeErrorMessage(cause, "Não foi possível consultar os tipos da subtarefa.")); } });
    return () => controller.abort();
  }, [newChild]);
  async function change(permission: Permission, path: string, method: string, body: object) {
    if (readOnly || !may(permission)) return;
    const updated = await command.execute<HospitalTaskView>(`/hospital-tasks/${task.id}${path}`, method, { ...body, expectedVersion: task.version });
    if (updated) onSaved(updated);
  }
  function chooseAction(next: HospitalTaskCommand) {
    const phase = next === "START" ? "IN_PROGRESS" : next === "COMPLETE" ? "COMPLETED" : "CANCELLED";
    setAction(next); setStateCode(task.typeSnapshot.states.find((state) => state.phase === phase)?.code ?? ""); setNote(""); setReason("");
  }
  async function saveMetadata() {
    setInputError("");
    try {
      const plannedStartAt = start ? hospitalDateTimeInputToIso(start) : null; const plannedEndAt = end ? hospitalDateTimeInputToIso(end) : null;
      if (plannedStartAt && plannedEndAt && plannedStartAt > plannedEndAt) throw new Error("O fim planejado não pode anteceder o início.");
      await change("hospital_task.update", "", "PATCH", { title: title.trim(), description: description.trim(), plannedStartAt, plannedEndAt });
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : "Revise as datas."); }
  }
  const childTypes = creationOptions.data?.types ?? types;
  const pendingDependencies = view.dependencies.filter((dependency) => !dependency.satisfied);
  const phaseForAction = action === "START" ? "IN_PROGRESS" : action === "COMPLETE" ? "COMPLETED" : "CANCELLED";
  return <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} onChange={onDirty}>
    <div className="page-heading"><div><p className="eyebrow">Atividade hospitalar · {task.taskCode}</p><h1>{task.title}</h1><p className="page-lede">{task.typeSnapshot.name} · {directoryName} · {task.typeSnapshot.states.find((state) => state.code === task.status)?.label ?? PHASE_LABELS[task.phase]}</p></div></div>
    <section className="panel" aria-label="Contexto da atividade">{view.patient ? <><p><Link href={`/patients/${view.patient.id}/diagnostics`}>{view.patient.displayName} · {view.patient.externalId}</Link> · {view.patient.species} · tutor {view.patient.ownerLabel}</p><p>Atendimento {view.encounter?.externalId ?? "vinculado"} · {view.encounter?.status === "OPEN" ? "Aberto" : "Encerrado"}</p></> : <p>Rotina operacional sem paciente vinculado.</p>}<p>Autoria: {task.authorId === user.id ? user.displayName : view.eligibleAssignees.find((entry) => entry.id === task.authorId)?.displayName ?? "Outro profissional autorizado"}</p><p>Responsável: {view.eligibleAssignees.find((entry) => entry.id === task.responsibleUserId)?.displayName ?? (task.responsibleUserId ? "Profissional atribuído" : "Sem responsável")}</p><p>Equipe executora: {task.executorTeamUserIds.length ? task.executorTeamUserIds.map((id) => view.eligibleAssignees.find((entry) => entry.id === id)?.displayName ?? "Profissional registrado").join(", ") : "Nenhum executor adicional"}</p><p>Participantes: {task.participantUserIds.length ? task.participantUserIds.map((id) => view.eligibleAssignees.find((entry) => entry.id === id)?.displayName ?? "Profissional registrado").join(", ") : "Sem participantes adicionais"}</p><p>Planejado: {formatHospitalDateTime(task.plannedStartAt)} até {formatHospitalDateTime(task.plannedEndAt)}</p><p>Execução real: {formatHospitalDateTime(task.startedAt)} · conclusão: {formatHospitalDateTime(task.completedAt)}</p>{task.description && <p>{task.description}</p>}{task.completionNote && <p>Nota de conclusão: {task.completionNote}</p>}{task.cancellationReason && <p>Cancelamento: {task.cancellationReason}</p>}</section>
    <section className="panel" aria-label="Comandos da atividade">{may("hospital_task.assign") && !task.responsibleUserId && view.eligibleAssignees.some((entry) => entry.id === user.id) && <ActionButton state={command.busy ? "pending" : "idle"} onClick={() => void change("hospital_task.assign", "/assignment", "PUT", { responsibleUserId: user.id })}>Assumir atividade</ActionButton>}
      {may("hospital_task.execute") && !task.isDraft && !task.archivedAt && <>{task.phase === "PENDING" && <ActionButton state={command.busy ? "pending" : "idle"} disabled={pendingDependencies.some((dependency) => dependency.blocks === "START")} onClick={() => chooseAction("START")}>Iniciar atividade</ActionButton>}{task.phase === "IN_PROGRESS" && !task.checklistSnapshot?.clinicalProcess && <ActionButton state={command.busy ? "pending" : "idle"} disabled={pendingDependencies.some((dependency) => dependency.blocks === "COMPLETE")} onClick={() => chooseAction("COMPLETE")}>Concluir atividade</ActionButton>}{["PENDING", "IN_PROGRESS"].includes(task.phase) && <button type="button" className="button button-ghost" onClick={() => chooseAction("CANCEL")}>Cancelar atividade</button>}</>}
      {action && may("hospital_task.execute") && <form aria-label="Confirmar comando da atividade" onSubmit={(event) => { event.preventDefault(); if (action === "CANCEL" && !reason.trim()) return; void change("hospital_task.execute", "/commands", "POST", { command: action, stateCode, ...(note.trim() ? { note: note.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }); }}><label>Estado de destino<select value={stateCode} required onChange={(event) => setStateCode(event.target.value)}>{task.typeSnapshot.states.filter((state) => state.phase === phaseForAction).map((state) => <option key={state.code} value={state.code}>{state.label}</option>)}</select></label>{action === "CANCEL" ? <label>Motivo do cancelamento<textarea required value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label> : <label>Nota de execução (opcional)<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} /></label>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Confirmar {action === "START" ? "início" : action === "COMPLETE" ? "conclusão" : "cancelamento"}</ActionButton><button type="button" disabled={command.busy} onClick={() => setAction(undefined)}>Voltar sem confirmar</button></form>}
      {!view.permissions.some((permission) => permission !== "hospital_task.view") && <p>Esta atividade está disponível somente para consulta.</p>}
    </section>
    {may("hospital_task.update") && <section className="panel"><h2>Editar atividade e planejamento</h2><form aria-label="Editar atividade hospitalar" onSubmit={(event) => { event.preventDefault(); void saveMetadata(); }}><label>Título<input value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label><label>Descrição<textarea value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} /></label><label>Início planejado<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Fim planejado<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><p className="field-hint">Horário do hospital; planejamento não cria reserva.</p><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar atividade</ActionButton></form></section>}
    {task.phase === "PENDING" && !task.parentTaskId && !view.children.length && !view.dependencies.length && may("hospital_task.update") && user.permissions?.includes("patient.view") && <section className="panel"><h2>Vínculo assistencial</h2><button type="button" onClick={() => setContextOpen((open) => !open)} aria-expanded={contextOpen}>Alterar paciente e atendimento</button>{contextOpen && <form aria-label="Alterar contexto da atividade" onSubmit={(event) => { event.preventDefault(); if (Boolean(context.patientId) !== Boolean(context.encounterId) || task.typeSnapshot.careContextRequired && !context.patientId) { setInputError("Informe paciente e atendimento juntos para este vínculo assistencial."); return; } void change("hospital_task.update", "/context", "PUT", { patientId: context.patientId ?? null, encounterId: context.encounterId ?? null }); }}><PlannerContextFields value={context} onChange={setContext} currentPatient={view.patient} required={task.typeSnapshot.careContextRequired} allowed /><p className="field-hint">Disponível antes da execução. O novo contexto será validado junto ao acesso da equipe e registrado no histórico.</p><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar vínculo assistencial</ActionButton></form>}</section>}
    {may("hospital_task.assign") && management && <section className="panel"><h2>Responsabilidade e participação</h2><form aria-label="Atribuir atividade" onSubmit={(event) => { event.preventDefault(); void change("hospital_task.assign", "/assignment", "PUT", { responsibleUserId: responsible || null, executorTeamUserIds: executors, participantUserIds: participants }); }}><label>Responsável<select value={responsible} onChange={(event) => setResponsible(event.target.value)}><option value="">Sem responsável</option>{view.eligibleAssignees.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}{responsible && !view.eligibleAssignees.some((entry) => entry.id === responsible) && <option value={responsible} disabled>Atribuição existente indisponível</option>}</select></label>{([{ label: "Equipe executora", value: executors, set: setExecutors }, { label: "Participantes", value: participants, set: setParticipants }] as const).map((group) => <fieldset key={group.label}><legend>{group.label}</legend>{view.eligibleAssignees.map((entry) => <label key={entry.id}><input type="checkbox" checked={group.value.includes(entry.id)} onChange={(event) => group.set((current) => event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id))} />{entry.displayName}</label>)}</fieldset>)}<p className="field-hint">Atribuição não concede acesso ao paciente nem muda a autoria clínica.</p><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar responsáveis</ActionButton></form></section>}
    {may("hospital_task.priority.update") && <section className="panel"><h2>Reclassificar prioridade</h2><form aria-label="Reclassificar atividade" onSubmit={(event) => { event.preventDefault(); if (priorityReason.trim()) void change("hospital_task.priority.update", "/priority", "PUT", { priority, reason: priorityReason.trim() }); }}><label>Prioridade<select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="ROUTINE">Rotina</option><option value="URGENT">Urgente</option><option value="EMERGENCY">Emergência</option></select></label><label>Motivo da prioridade<textarea required maxLength={500} value={priorityReason} onChange={(event) => setPriorityReason(event.target.value)} /></label><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar prioridade</ActionButton></form></section>}
    <HospitalTaskExecution user={user} view={view} readOnly={readOnly} onSaved={onSaved} />
    <section className="panel"><h2>Dependências</h2>{!view.dependencies.length ? <p>Sem dependências registradas.</p> : <ul>{view.dependencies.map((dependency) => <li key={dependency.id}>{dependency.restricted ? "Pendência fora do seu acesso" : <><Link href={dependency.targetType === "HOSPITAL_TASK" ? `/planner/tasks/${dependency.targetId}` : `/queues?item=${encodeURIComponent(dependency.targetId)}`}>{dependency.label}</Link> · {dependency.satisfied ? "Concluída" : "Pendente"}</>} · bloqueia {dependency.blocks === "START" ? "início" : "conclusão"}{!dependency.restricted && may("hospital_task.dependency.manage") && <button type="button" disabled={command.busy} onClick={() => void change("hospital_task.dependency.manage", "/dependencies", "PUT", { targetType: dependency.targetType, targetId: dependency.targetId, blocks: dependency.blocks, active: false })}>Remover dependência</button>}</li>)}</ul>}
      {may("hospital_task.dependency.manage") && <form aria-label="Vincular dependência" onSubmit={(event) => { event.preventDefault(); if (target && ["HOSPITAL_TASK", "DIAGNOSTIC_ITEM"].includes(target.type)) void change("hospital_task.dependency.manage", "/dependencies", "PUT", { targetType: target.type, targetId: target.id, blocks, active: true }); }}><label>Buscar atividade ou exame<input value={query} onChange={(event) => { setQuery(event.target.value); setTarget(undefined); }} minLength={2} maxLength={200} /></label>{search.items.filter((entry) => entry.id !== task.id).map((entry) => <label key={`${entry.type}:${entry.id}`}><input type="radio" name="dependency-target" checked={target?.id === entry.id && target.type === entry.type} onChange={() => setTarget(entry)} />{entry.label} · {entry.type === "DIAGNOSTIC_ITEM" ? "Exame diagnóstico" : "Atividade hospitalar"}</label>)}{search.error && <p role="alert">{search.error}</p>}{search.nextCursor && <button type="button" disabled={search.loadingMore} onClick={() => void search.loadMore()}>Mais opções de dependência</button>}<label>Comando bloqueado<select value={blocks} onChange={(event) => setBlocks(event.target.value as typeof blocks)}><option value="START">Iniciar</option><option value="COMPLETE">Concluir</option></select></label><ActionButton type="submit" disabled={!target} state={command.busy ? "pending" : "idle"}>Adicionar dependência</ActionButton></form>}
    </section>
    <section className="panel"><h2>Subtarefas</h2><p className="field-hint">Concluir esta atividade não conclui subtarefas ou exames automaticamente.</p>{view.children.length ? <ul>{view.children.map((child) => <li key={child.id}><Link href={`/planner/tasks/${child.id}`}>{child.title}</Link> · {PHASE_LABELS[child.phase]}</li>)}</ul> : <EmptyState title="Sem subtarefas" message="Componha esta atividade quando precisar de etapas independentes." />}{user.permissions?.includes("hospital_task.create") && may("hospital_task.dependency.manage") && <button type="button" onClick={() => setNewChild(true)}>Criar subtarefa</button>}</section>
    {newChild && childTypes.length === 0 && (typesError ? <p role="alert">{typesError} <button type="button" onClick={() => setNewChild(false)}>Fechar criação da subtarefa</button></p> : <p role="status">Carregando tipos de atividade para a subtarefa…</p>)}
    {newChild && childTypes.length > 0 && <PlannerTaskForm user={user} types={childTypes} departments={creationOptions.data?.departments.map((entry) => ({ ...entry, active: true })) ?? directory.departments} parentTaskId={task.id} onClose={() => setNewChild(false)} onCreated={() => { setNewChild(false); window.dispatchEvent(new Event("cvg:realtime-updated")); }} />}
    {(inputError || command.error) && <p role="alert" className="form-alert">{inputError || command.error}</p>}
  </fieldset>;
}
