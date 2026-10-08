"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState } from "./feedback-states";
import { LoadingState } from "./feedback-states";

export interface ArchiveEntrySummary {
  requestId: string;
  requestCode: string;
  archivedAt: string;
  completedAt: string;
  services: { code: string; name: string }[];
  attachmentCount: number;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(value));
}

/**
 * Exams completed more than 24 months ago (D5) live in the clinical archive,
 * outside the active aggregate. The list is fetched only when the section is
 * opened, so the patient workspace never pays for it.
 */
export function PatientArchive({ patientId }: { patientId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ArchiveEntrySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setEntries(await apiFetch<ArchiveEntrySummary[]>(`/patients/${patientId}/archive?limit=50`));
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível carregar o arquivo do paciente."));
    } finally {
      setLoading(false);
    }
  }, [patientId]);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && entries === null && !loading) void load();
  };
  return <section className="panel patient-archive-panel" aria-label="Arquivo de exames do paciente" data-testid="patient-archive">
    <div className="panel-heading">
      <div><p className="eyebrow">Arquivo clínico</p><h2>Arquivo (exames com mais de 24 meses)</h2></div>
      <button type="button" className="button button-ghost" aria-expanded={expanded} aria-controls="patient-archive-content" onClick={toggle}>{expanded ? "Recolher arquivo" : "Expandir arquivo"}</button>
    </div>
    <div id="patient-archive-content" hidden={!expanded}>
      {expanded && loading && <LoadingState label="Carregando arquivo…" />}
      {expanded && error && <ErrorState title="Arquivo indisponível" message={error} onRetry={load} retrying={loading} />}
      {expanded && !loading && !error && entries && entries.length === 0 && <EmptyState announce title="Nenhum exame arquivado" message="Este paciente não tem exames arquivados no seu escopo." />}
      {expanded && !loading && !error && entries && entries.length > 0 && <ul className="patient-archive-list">{entries.map((entry) => <li key={entry.requestId} className="patient-archive-entry">
        <Link href={`/archive/${entry.requestId}`}><strong>{entry.requestCode}</strong></Link>
        <span>{entry.services.map((service) => service.name).join(", ") || "Sem exames"}</span>
        <small>Concluído em {formatDate(entry.completedAt)} · arquivado {formatRelativeTime(entry.archivedAt)} · {entry.attachmentCount} {entry.attachmentCount === 1 ? "anexo" : "anexos"}</small>
      </li>)}</ul>}
    </div>
  </section>;
}
