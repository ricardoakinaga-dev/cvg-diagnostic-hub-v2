"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SampleLabel, SampleStatus } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";

export const sampleStatusLabels: Record<SampleStatus, string> = { EXPECTED: "Esperada", RECEIVED: "Recebida", REJECTED: "Rejeitada", REPLACED: "Substituída" };

/** "Etiqueta" link shown next to a sample in request, peek and patient views. */
export function SampleLabelLink({ sampleId, accessionCode }: { sampleId: string; accessionCode?: string }) {
  return <Link className="text-link" href={`/samples/${sampleId}/label`} aria-label={accessionCode ? `Etiqueta da amostra ${accessionCode}` : "Etiqueta da amostra"}>Etiqueta</Link>;
}

function formatRequestedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function SampleLabelView({ sampleId }: { sampleId: string }) {
  const [label, setLabel] = useState<SampleLabel | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setLabel(await apiFetch<SampleLabel>(`/samples/${sampleId}/label`));
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível carregar a etiqueta."));
    } finally {
      setLoading(false);
    }
  }, [sampleId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!label && loading) return <LoadingState label="Carregando etiqueta" />;
  if (!label) return <ErrorState page title="Etiqueta indisponível" message={error || "A amostra não foi encontrada."} onRetry={load} retrying={loading} action={<Link className="button button-ghost" href="/">Voltar à visão geral</Link>} />;

  const { widthMm, heightMm, barcode } = label.label;
  return <div className="sample-label-page">
    {/* Browser print: the page size follows the label stock configured by the hospital. */}
    <style>{`@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; } .sample-label-sheet { width: ${widthMm}mm; height: ${heightMm}mm; }`}</style>
    <div className="sample-label-toolbar">
      <Link className="back-link" href={`/requests/${label.request.id}`}>Voltar</Link>
      <button type="button" className="button" onClick={() => window.print()}>Imprimir</button>
    </div>
    <h1 className="sample-label-title">Etiqueta da amostra</h1>
    <p className="sample-label-status">Status da amostra: <strong>{sampleStatusLabels[label.sample.status]}</strong> · etiqueta {widthMm} × {heightMm} mm</p>
    <section className="sample-label-sheet" aria-label={`Etiqueta ${label.sample.accessionCode}`}>
      <strong className="sample-label-code">{label.sample.accessionCode}</strong>
      <svg className="sample-label-barcode" role="img" aria-label={`Código de barras ${label.sample.accessionCode}`} viewBox={`0 0 ${barcode.modules} 40`} preserveAspectRatio="none" shapeRendering="crispEdges">
        <rect x={0} y={0} width={barcode.modules} height={40} fill="#fff" />
        {barcode.bars.map((bar) => <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={40} fill="#000" />)}
      </svg>
      <span className="sample-label-patient">{label.patient.displayName}</span>
      <span className="sample-label-line">{label.patient.species} · {label.patient.externalId}</span>
      <span className="sample-label-line">{label.request.requestCode} · {label.sample.sampleType}</span>
      <span className="sample-label-line">{label.services.map((entry) => entry.name).join(", ")}</span>
      <span className="sample-label-line">Solicitado em {formatRequestedAt(label.requestedAt)}</span>
    </section>
  </div>;
}
