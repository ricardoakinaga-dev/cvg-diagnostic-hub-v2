"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ItemState, Priority } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";
import { PriorityBadge, StatusBadge, statusLabel } from "./status-badge";

interface ArchivedVersion {
  id: string;
  sequence: number;
  status: "RELEASED" | "SUPERSEDED" | "VOIDED";
  content: Record<string, unknown>;
  narrative: string;
  conclusion?: string;
  releasedAt?: string;
  critical: boolean;
  amendmentReason?: string;
}

export interface ArchivedRequestData {
  readOnly: true;
  archivedAt: string;
  request: { id: string; requestCode: string; patientId: string; aggregateStatus: string; priority: Priority; createdAt: string; updatedAt: string };
  patient: { id: string; displayName: string; species: string; externalId: string } | null;
  items: Array<{
    id: string;
    service: { code: string; name: string };
    status: ItemState;
    priority: Priority;
    completedAt?: string;
    cancellationReason?: string;
    rejectionReason?: string;
    note?: string;
    results: Array<{ id: string; lifecycleStatus: "DRAFT" | "RELEASED" | "VOIDED"; versions: ArchivedVersion[] }>;
  }>;
  samples: Array<{ id: string; accessionCode: string; sampleType: string; status: string }>;
  attachments: Array<{ id: string; safeName: string; detectedMime: string; sizeBytes: number }>;
}

const aggregateLabels: Record<string, string> = { COMPLETED: "Concluído", CANCELLED: "Cancelado" };
const versionLabels: Record<ArchivedVersion["status"], string> = { RELEASED: "Liberada", SUPERSEDED: "Substituída por emenda", VOIDED: "Invalidada" };

function formatDateTime(value: string | undefined): string {
  return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Não informado";
}

/** Read-only page for a request moved to the clinical archive (PROD-501). */
export function ArchivedRequest({ requestId }: { requestId: string }) {
  const [data, setData] = useState<ArchivedRequestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await apiFetch<ArchivedRequestData>(`/archive/requests/${requestId}`));
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível carregar o registro arquivado."));
    } finally {
      setLoading(false);
    }
  }, [requestId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading && !data) return <LoadingState label="Carregando registro arquivado…" />;
  if (!data) return <ErrorState page title="Registro arquivado indisponível" message={error} onRetry={load} retrying={loading} action={<Link className="button button-ghost" href="/patients">Voltar aos pacientes</Link>} />;
  return <div className="request-detail-page archived-request" data-testid="archived-request">
    {data.patient && <Link href={`/patients/${data.patient.id}/diagnostics`} className="back-link">Voltar ao paciente</Link>}
    <div className="panel archive-notice" role="note"><strong>Somente leitura — registro arquivado</strong><small>Arquivado em {formatDateTime(data.archivedAt)}. Este registro não pode mais ser alterado.</small></div>
    <div className="detail-heading">
      <div>
        <p className="eyebrow">Solicitação arquivada</p>
        <h1>{data.request.requestCode}</h1>
        <p className="page-lede">{data.patient ? `${data.patient.displayName} · ${data.patient.species} · ${data.patient.externalId}` : "Paciente não disponível"} · {aggregateLabels[data.request.aggregateStatus] ?? "Estado não informado"} · criada em {formatDateTime(data.request.createdAt)}</p>
      </div>
      <PriorityBadge priority={data.request.priority} />
    </div>
    {data.items.map((item) => <section className="panel archived-item" key={item.id} aria-label={item.service.name}>
      <div className="panel-heading"><div><p className="eyebrow">Exame</p><h2>{item.service.name}</h2></div><StatusBadge status={item.status} label={statusLabel(item.status)} /></div>
      {item.completedAt && <p>Concluído em {formatDateTime(item.completedAt)}</p>}
      {item.note && <p>Observação: {item.note}</p>}
      {item.cancellationReason && <p>Motivo do cancelamento: {item.cancellationReason}</p>}
      {item.rejectionReason && <p>Motivo da rejeição: {item.rejectionReason}</p>}
      {item.results.flatMap((result) => result.versions).length === 0 && <p>Nenhum resultado liberado.</p>}
      {item.results.map((result) => result.versions.map((version) => <article className="archived-version" key={version.id} aria-label={`Versão ${version.sequence}`}>
        <h3>Versão {version.sequence} · {versionLabels[version.status]}{version.critical ? " · crítico" : ""}</h3>
        <small>{version.releasedAt ? `Liberada em ${formatDateTime(version.releasedAt)}` : "Sem data de liberação"}{version.amendmentReason ? ` · Emenda: ${version.amendmentReason}` : ""}</small>
        <p>{version.narrative}</p>
        {version.conclusion && <p><strong>Conclusão:</strong> {version.conclusion}</p>}
        {Object.keys(version.content).length > 0 && <dl className="result-fields">{Object.entries(version.content).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>}
      </article>))}
    </section>)}
    {data.samples.length > 0 && <section className="panel" aria-label="Amostras"><div className="panel-heading"><h2>Amostras</h2></div><ul>{data.samples.map((sample) => <li key={sample.id}>{sample.accessionCode} · {sample.sampleType}</li>)}</ul></section>}
    {data.attachments.length > 0 && <section className="panel" aria-label="Anexos"><div className="panel-heading"><h2>Anexos</h2></div><ul>{data.attachments.map((attachment) => <li key={attachment.id}>{attachment.safeName} · {attachment.detectedMime}</li>)}</ul></section>}
  </div>;
}
