"use client";

import Link from "next/link";
import { useState } from "react";
import { WORK_NOTIFICATION_EVENTS, type SessionUser, type WorkNotificationPreference, type WorkNotificationView } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerIdentity, usePlannerPage } from "./use-planner";
import { usePlannerResource } from "./use-planner-resource";
import { usePlannerCommand } from "./planner-command";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";

export const workEventLabels = { TASK_ASSIGNED: "Responsabilidade atribuída", TASK_CHANGED: "Atividade alterada", TASK_DUE: "Prazo da atividade", TASK_COMMENTED: "Novo comentário", TASK_MENTIONED: "Menção em comentário", HANDOFF_OFFERED: "Passagem de plantão oferecida", HANDOFF_DECIDED: "Passagem de plantão respondida", PLAN_UPDATED: "Plano atualizado", RECURRENCE_BLOCKED: "Rotina bloqueada", DOCUMENT_PUBLISHED: "Documento publicado" };
export function WorkInbox() {
  const { user, error } = usePlannerIdentity(); const [unreadOnly, setUnreadOnly] = useState(false); const [includeArchived, setIncludeArchived] = useState(false); const command = usePlannerCommand();
  const page = usePlannerPage<WorkNotificationView>(user?.id, `/work-notifications?limit=50&unreadOnly=${unreadOnly}&includeArchived=${includeArchived}`, user?.permissions?.includes("work_notification.view"));
  if (error) return <ErrorState page title="Caixa de trabalho indisponível" message={error} onRetry={page.reload} />;
  if (!user) return <LoadingState label="Carregando caixa de trabalho" />;
  if (!user.permissions?.includes("work_notification.view")) return <ErrorState page title="Recurso fora do seu acesso" message="Você não tem acesso à caixa de trabalho." onRetry={page.reload} />;
  const may = (entry: WorkNotificationView, permission: "work_notification.read" | "work_notification.archive") => !page.error && user.permissions?.includes(permission) === true && entry.permissions.includes(permission);
  async function read(ids?: string[], value = true) { if (!user?.permissions?.includes("work_notification.read") || page.error) return; const result = await command.execute("/work-notifications/read", "POST", ids ? { notificationIds: ids, read: value } : { all: true, read: true }); if (result) void page.reload(); }
  async function archive(entry: WorkNotificationView) { if (!may(entry, "work_notification.archive")) return; const result = await command.execute(`/work-notifications/${entry.notification.id}/archive`, "POST", { archived: !entry.notification.archivedAt, expectedVersion: entry.notification.version }); if (result) void page.reload(); }
  return <div className="detail-page"><h1>Caixa de trabalho</h1><p>Marcar como lida registra sua leitura pessoal. Confirmação clínica, resultado crítico e aceite de plantão usam seus comandos próprios.</p><label><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />Somente não lidas</label><label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Incluir arquivadas</label>{user.permissions.includes("work_notification.read") && <ActionButton state={command.busy ? "pending" : "idle"} disabled={Boolean(page.error)} onClick={() => void read()}>Marcar todas as autorizadas como lidas</ActionButton>}{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{command.error && <p role="alert">{command.error}</p>}{!page.error && typeof page.unread === "number" && <p role="status">Carregados {page.items.length} de {page.total} avisos nesta seleção. {page.unread} não lidos na caixa ativa.</p>}{page.loading && <LoadingState label="Atualizando caixa de trabalho" />}<ul>{page.items.map((entry) => <li key={entry.notification.id} className="panel"><Link href={entry.target.deepLink}>{entry.target.label}</Link><p>{workEventLabels[entry.notification.eventType]} · {formatHospitalDateTime(entry.notification.createdAt)} · {entry.notification.readAt ? "Lida" : "Não lida"}{entry.notification.archivedAt ? " · Arquivada" : ""}</p>{may(entry, "work_notification.read") && <button type="button" disabled={command.busy} onClick={() => void read([entry.notification.id], Boolean(!entry.notification.readAt))}>{entry.notification.readAt ? "Marcar como não lida" : "Marcar como lida"}</button>}{may(entry, "work_notification.archive") && <button type="button" disabled={command.busy} onClick={() => void archive(entry)}>{entry.notification.archivedAt ? "Restaurar na caixa" : "Arquivar na minha caixa"}</button>}</li>)}</ul>{!page.loading && !page.error && !page.items.length && <EmptyState title="Caixa sem itens nesta seleção" message="Alterações que você acompanha aparecerão aqui enquanto o alvo permanecer autorizado." />}{page.nextCursor && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>Carregar mais avisos</button>}<WorkInboxPreferences key={user.id} user={user} /></div>;
}
function WorkInboxPreferences({ user }: { user: SessionUser }) {
  const enabled = user.permissions?.includes("work_notification.preferences.manage") === true; const resource = usePlannerResource<WorkNotificationPreference>(user.id, "/work-notifications/preferences", enabled);
  if (!enabled) return null;
  if (resource.error) return <PartialNotice message={resource.error} onRetry={resource.reload} />;
  if (!resource.data) return <LoadingState label="Carregando preferências dos avisos" />;
  return <InboxPreferenceForm key={`${user.id}:${resource.data.version}`} preference={resource.data} onSaved={resource.saved} />;
}
function InboxPreferenceForm({ preference, onSaved }: { preference: WorkNotificationPreference; onSaved: (value: WorkNotificationPreference) => void }) {
  const [mutedEvents, setMuted] = useState(preference.mutedEvents); const command = usePlannerCommand();
  return <form className="panel" aria-label="Preferências de avisos" onSubmit={(event) => { event.preventDefault(); void command.execute<WorkNotificationPreference>("/work-notifications/preferences", "PUT", { mutedEvents, expectedVersion: preference.version }).then((value) => { if (value) onSaved(value); }); }}><h2>Avisos do trabalho</h2><p>Selecione eventos para silenciar na sua caixa de trabalho. Esta preferência não altera alertas clínicos nem mensagens críticas.</p><fieldset disabled={command.busy}><legend>Eventos silenciados</legend>{WORK_NOTIFICATION_EVENTS.map((kind) => <label key={kind}><input type="checkbox" checked={mutedEvents.includes(kind)} onChange={(event) => setMuted(event.target.checked ? [...mutedEvents, kind] : mutedEvents.filter((entry) => entry !== kind))} />{workEventLabels[kind]}</label>)}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar preferências de avisos</ActionButton></fieldset>{command.error && <p role="alert">{command.error}</p>}</form>;
}
