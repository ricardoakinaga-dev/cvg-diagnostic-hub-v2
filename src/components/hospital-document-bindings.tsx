"use client";

import Link from "next/link";
import type { HospitalDocumentSnapshot, HospitalDocumentSummary, SessionUser } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerPage } from "./use-planner";
import { HospitalDocumentRenderer } from "./hospital-document-content";
import { PartialNotice } from "./feedback-states";

export function HospitalDocumentPicker({ user, departmentCode, value, onChange, disabled = false }: { user: SessionUser; departmentCode: string; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const enabled = user.permissions?.includes("hospital_document.view") === true; const page = usePlannerPage<HospitalDocumentSummary>(user.id, `/hospital-documents?departmentCode=${encodeURIComponent(departmentCode)}&limit=50`, enabled);
  if (!enabled) return null;
  return <fieldset disabled={disabled || Boolean(page.error)}><legend>Protocolos aprovados para vincular</legend><p>A atividade captura a publicação aprovada vigente. Alterações futuras do documento não substituem a versão capturada.</p>{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{page.items.filter((entry) => entry.currentStatus === "APPROVED" && !entry.archived).map((entry) => <label key={entry.id}><input type="checkbox" checked={value.includes(entry.id)} onChange={(event) => onChange(event.target.checked ? [...value, entry.id].slice(0, 20) : value.filter((id) => id !== entry.id))} />{entry.title} · revisão {entry.currentRevision}</label>)}{value.filter((id) => !page.items.some((entry) => entry.id === id && entry.currentStatus === "APPROVED" && !entry.archived)).map((id) => <label key={id}><input type="checkbox" checked onChange={() => onChange(value.filter((entry) => entry !== id))} />Vínculo existente fora das opções atuais</label>)}{!page.loading && !page.items.length && <p>Nenhum documento autorizado neste setor.</p>}{page.nextCursor && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>Mais protocolos disponíveis</button>}</fieldset>;
}
export function HospitalDocumentSnapshots({ snapshots }: { snapshots?: HospitalDocumentSnapshot[] }) {
  if (!snapshots?.length) return null;
  return <section className="panel"><h2>Protocolos capturados</h2>{snapshots.map((snapshot) => <details key={`${snapshot.documentId}:${snapshot.revisionId}`}><summary>{snapshot.title} · revisão {snapshot.revision}</summary><p>{snapshot.code} · aprovação conforme {snapshot.policyReference} · captura {formatHospitalDateTime(snapshot.capturedAt)}</p><HospitalDocumentRenderer content={snapshot.content} /><Link href={`/planner/documents/${encodeURIComponent(snapshot.documentId)}`}>Consultar documento e revisões atuais</Link></details>)}</section>;
}
