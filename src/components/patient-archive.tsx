"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, apiFetchWithMeta, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { formatHospitalDate } from "@/lib/hospital-time";
import { ActionButton } from "@cvg/ui";
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
  return formatHospitalDate(value);
}

/**
 * Exams completed more than 24 months ago (D5) live in the clinical archive,
 * outside the active aggregate. The list is fetched only when the section is
 * opened, so the patient workspace never pays for it.
 */
export function PatientArchive({ patientId }: { patientId: string }) {
  return <PatientArchiveContent key={patientId} patientId={patientId} />;
}

function PatientArchiveContent({ patientId }: { patientId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ArchiveEntrySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string>();
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current += 1; }, []);
  const load = useCallback(async (cursor?: string) => {
    const current = ++version.current;
    setLoading(true);
    setLoadingMore(Boolean(cursor));
    setError("");
    try {
      const page = await apiFetchWithMeta<ArchiveEntrySummary[]>(`/patients/${patientId}/archive?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (version.current !== current) return;
      setEntries((old) => cursor ? [...new Map([...(old ?? []), ...page.data].map((entry) => [entry.requestId, entry])).values()] : page.data);
      setNextCursor(typeof page.meta.nextCursor === "string" ? page.meta.nextCursor : undefined);
      setTotal(typeof page.meta.total === "number" ? page.meta.total : page.data.length);
    } catch (cause) {
      if (version.current === current) {
        if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { setEntries(null); setNextCursor(undefined); }
        setError(getSafeErrorMessage(cause, "Não foi possível carregar o arquivo do paciente."));
      }
    } finally {
      if (version.current === current) { setLoading(false); setLoadingMore(false); }
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
      {expanded && loading && !entries && <LoadingState label="Carregando arquivo…" />}
      {expanded && error && <ErrorState title="Arquivo indisponível" message={error} onRetry={() => load(entries ? nextCursor : undefined)} retrying={loading} />}
      {expanded && !loading && !error && entries && entries.length === 0 && <EmptyState announce title="Nenhum exame arquivado" message="Este paciente não tem exames arquivados no seu escopo." />}
      {expanded && entries && entries.length > 0 && <ul className="patient-archive-list">{entries.map((entry) => <li key={entry.requestId} className="patient-archive-entry">
        <Link href={`/archive/${entry.requestId}`}><strong>{entry.requestCode}</strong></Link>
        <span>{entry.services.map((service) => service.name).join(", ") || "Sem exames"}</span>
        <small>Concluído em {formatDate(entry.completedAt)} · arquivado {formatRelativeTime(entry.archivedAt)} · {entry.attachmentCount} {entry.attachmentCount === 1 ? "anexo" : "anexos"}</small>
      </li>)}</ul>}
      {expanded && nextCursor && <div className="workspace-pagination"><span>Carregados {entries?.length ?? 0} de {total} protocolos arquivados</span><ActionButton tone="ghost" state={loadingMore ? "pending" : "idle"} disabled={loading} onClick={() => void load(nextCursor)}>{loadingMore ? "Carregando…" : "Carregar mais exames arquivados"}</ActionButton></div>}
    </div>
  </section>;
}
