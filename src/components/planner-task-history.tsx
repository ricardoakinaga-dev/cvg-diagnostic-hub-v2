"use client";

import type { AuditEvent } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerPage } from "./use-planner";
import { EmptyState, PartialNotice } from "./feedback-states";

const eventLabels: Record<string, string> = { HospitalTaskCreated: "Atividade criada", HospitalTaskCreatedFromIntake: "Atividade criada pela triagem", HospitalTaskUpdated: "Atividade editada", HospitalTaskAssigned: "Responsabilidade atualizada", HospitalTaskReprioritized: "Prioridade reclassificada", HospitalTaskDependencyUpdated: "Dependência atualizada", HospitalTaskContextUpdated: "Vínculo assistencial atualizado" };
function eventLabel(event: AuditEvent) {
  if (event.eventType === "HospitalTaskTransitioned") return event.metadata.command === "START" ? "Execução iniciada" : event.metadata.command === "COMPLETE" ? "Atividade concluída" : event.metadata.command === "CANCEL" ? "Atividade cancelada" : "Estado da atividade atualizado";
  return eventLabels[event.eventType] ?? "Atividade atualizada";
}
export function PlannerTaskHistory({ userId, taskId }: { userId: string; taskId: string }) {
  const page = usePlannerPage<AuditEvent>(userId, `/hospital-tasks/${encodeURIComponent(taskId)}/history?limit=25`, true, true);
  return <section className="panel" aria-label="Histórico da atividade"><h2>Histórico da atividade</h2>{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{page.loading && !page.items.length && <p role="status">Carregando histórico…</p>}{!page.loading && !page.items.length && !page.error && <EmptyState title="Nenhum evento registrado" message="Novas operações aparecerão na trilha da atividade." />}
    <ol className="timeline">{page.items.map((event) => <li key={event.id}><div><strong>{eventLabel(event)}</strong><small><time dateTime={event.occurredAt}>{formatHospitalDateTime(event.occurredAt)}</time></small>{typeof event.metadata.reason === "string" && <p>Motivo: {event.metadata.reason}</p>}{typeof event.metadata.note === "string" && <p>Nota: {event.metadata.note}</p>}</div></li>)}</ol>
    {page.nextCursor && <ActionButton tone="ghost" state={page.loadingMore ? "pending" : "idle"} onClick={() => void page.loadMore()}>Carregar mais histórico da atividade</ActionButton>}
  </section>;
}
