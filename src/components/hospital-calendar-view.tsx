"use client";

import Link from "next/link";
import { useState } from "react";
import type { HospitalCalendarEvent, HospitalResource, HospitalTaskView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDate, formatHospitalDateTime, hospitalDateKey } from "@/lib/hospital-time";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { usePlannerIdentity, usePlannerPage } from "./use-planner";
import { usePlannerResource } from "./use-planner-resource";
import { useDepartments } from "./use-departments";
import { defaultPlannerPeriod, PlannerPeriodFields } from "./planner-period";
import { HospitalReservationEditor } from "./hospital-reservation-controls";

const labels = { RESERVATION: "Reserva", DEADLINE: "Prazo", EXECUTION: "Execução registrada" };
export function HospitalCalendarView() {
  const { user, error } = usePlannerIdentity(); const [draft, setDraft] = useState(defaultPlannerPeriod); const [period, setPeriod] = useState(draft); const [department, setDepartment] = useState(""); const [resource, setResource] = useState(""); const [kind, setKind] = useState(""); const [inputError, setInputError] = useState("");
  const directory = useDepartments(user?.id); const mayRead = user?.permissions?.includes("hospital_calendar.view") === true;
  const page = usePlannerPage<HospitalCalendarEvent>(user?.id, `/hospital-calendar?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}&limit=50${department ? `&departmentCode=${encodeURIComponent(department)}` : ""}${resource ? `&resourceId=${encodeURIComponent(resource)}` : ""}${kind ? `&kinds=${kind}` : ""}`, mayRead);
  const resources = usePlannerPage<HospitalResource>(user?.id, `/hospital-resources?limit=50${department ? `&departmentCode=${encodeURIComponent(department)}` : ""}`, mayRead && user?.permissions?.includes("hospital_resource.view") === true);
  if (error) return <ErrorState page title="Agenda indisponível" message={error} onRetry={() => window.location.reload()} />;
  if (!user) return <LoadingState label="Carregando agenda hospitalar" />;
  if (!mayRead) return <ErrorState page title="Agenda fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={page.reload} />;
  const departments = new Map(directory.departments.map((entry) => [entry.code, entry.name])); for (const event of page.items) if (!departments.has(event.departmentCode)) departments.set(event.departmentCode, event.departmentCode);
  const days = new Map<string, HospitalCalendarEvent[]>(); for (const event of page.items) { const key = hospitalDateKey(event.startsAt); days.set(key, [...(days.get(key) ?? []), event]); }
  return <div className="detail-page"><Link href="/planner" className="back-link">Voltar ao planner</Link><h1>Agenda hospitalar</h1><p className="page-lede">Reserva ocupa recursos; prazo continua contando desde a solicitação; execução representa o horário efetivamente registrado.</p>
    <form className="panel" aria-label="Filtros da agenda" onSubmit={(event) => { event.preventDefault(); if (draft.from >= draft.to) { setInputError("O fim do período deve ocorrer depois do início."); return; } setInputError(""); setPeriod(draft); }}><PlannerPeriodFields value={draft} onChange={setDraft} /><label>Setor da agenda<select value={department} onChange={(event) => { setDepartment(event.target.value); setResource(""); }}><option value="">Todos os setores autorizados</option>{[...departments].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label><label>Recurso da agenda<select value={resource} onChange={(event) => setResource(event.target.value)}><option value="">Todos os recursos</option>{resources.items.filter((entry) => entry.kind !== "BED").map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.code}</option>)}</select></label>{resources.nextCursor && <button type="button" disabled={resources.loadingMore} onClick={() => void resources.loadMore()}>Carregar mais opções de recursos</button>}<label>Fonte do evento<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Todas as fontes</option>{Object.entries(labels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><ActionButton type="submit">Aplicar período</ActionButton>{inputError && <p role="alert">{inputError}</p>}</form>
    {page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{resources.error && <PartialNotice message={resources.error} onRetry={resources.reload} />}<p role="status">Mostrando {page.items.length} de {page.total} eventos autorizados.</p>
    {page.loading && !page.items.length ? <LoadingState label="Carregando eventos" /> : !page.items.length ? <EmptyState title="Nenhum evento neste período" message="Planejar datas não equivale a reservar um recurso. Confira a fonte e o intervalo." /> : [...days].map(([day, events]) => <section key={day} aria-label={`Agenda ${day}`}><h2>{formatHospitalDate(events[0].startsAt)}</h2>{events.map((event) => <CalendarEvent key={`${user.id}:${event.id}:${event.schedule?.version ?? ""}`} event={event} user={user} onChanged={() => void page.reload()} />)}</section>)}
    {page.nextCursor && <ActionButton tone="ghost" state={page.loadingMore ? "pending" : "idle"} onClick={() => void page.loadMore()}>Carregar mais eventos</ActionButton>}{user.permissions?.includes("hospital_resource.create") && <Link href="/admin/resources">Gerenciar recursos e disponibilidade</Link>}
  </div>;
}

function CalendarEvent({ event, user, onChanged }: { event: HospitalCalendarEvent; user: SessionUser; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const task = usePlannerResource<HospitalTaskView>(user.id, `/hospital-tasks/${encodeURIComponent(event.targetId)}`, editing && event.targetType === "HOSPITAL_TASK" && event.kind === "RESERVATION");
  const mayEdit = event.kind === "RESERVATION" && event.targetType === "HOSPITAL_TASK" && event.schedule?.status === "SCHEDULED" && user.permissions?.some((permission) => ["hospital_calendar.reschedule", "hospital_calendar.cancel"].includes(permission));
  return <article className="panel"><p className="eyebrow">{labels[event.kind]} · {event.targetType === "DIAGNOSTIC_ITEM" ? "Exame diagnóstico" : "Atividade hospitalar"}</p><h3><Link href={event.deepLink}>{event.label}</Link></h3><p>{formatHospitalDateTime(event.startsAt)}{event.endsAt && <> até {formatHospitalDateTime(event.endsAt)}</>} · {event.departmentCode}</p>{event.schedule && <p>Recurso: {event.schedule.resourceSnapshots?.map((snapshot) => snapshot.name).join(" / ") || event.schedule.resource}</p>}{event.kind === "DEADLINE" && <p className="field-hint">Prazo do trabalho, separado da disponibilidade de recursos.</p>}
    {mayEdit && <button type="button" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>Gerenciar reserva de {event.label}</button>}{editing && task.error && <PartialNotice message={task.error} onRetry={task.reload} />}{editing && task.loading && !task.data && <p role="status">Validando acesso à reserva…</p>}{editing && task.data && !task.error && event.schedule && <HospitalReservationEditor user={user} view={task.data} reservation={event.schedule} onChanged={() => { setEditing(false); onChanged(); }} />}
  </article>;
}
