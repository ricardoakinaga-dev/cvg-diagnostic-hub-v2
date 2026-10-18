"use client";

import Link from "next/link";
import type { HospitalResource, HospitalResourceSnapshot } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerPage } from "./use-planner";
import { PartialNotice } from "./feedback-states";

export function HospitalResourcePicker({ userId, departmentCode, selectedIds, onChange, snapshots = [], canConfigure = false }: { userId: string; departmentCode: string; selectedIds: string[]; onChange: (ids: string[]) => void; snapshots?: HospitalResourceSnapshot[]; canConfigure?: boolean }) {
  const page = usePlannerPage<HospitalResource>(userId, `/hospital-resources?departmentCode=${encodeURIComponent(departmentCode)}&limit=50`);
  const resources = page.items.filter((resource) => resource.kind !== "BED");
  const missing = selectedIds.filter((id) => !resources.some((resource) => resource.id === id));
  return <fieldset><legend>Recursos cadastrados</legend>{page.loading && !page.items.length && <p role="status">Consultando recursos do setor…</p>}{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}
    {resources.map((resource) => <label key={resource.id}><input type="checkbox" checked={selectedIds.includes(resource.id)} disabled={Boolean(page.error) || !selectedIds.includes(resource.id) && (!resource.active || resource.availability !== "AVAILABLE" || !resource.availabilityWindows.length || selectedIds.length >= 20)} onChange={(event) => onChange(event.target.checked ? [...selectedIds, resource.id] : selectedIds.filter((id) => id !== resource.id))} />{resource.name} · {resource.code}{resource.availability !== "AVAILABLE" ? " · indisponível" : !resource.availabilityWindows.length ? " · sem disponibilidade horária" : ""}{resource.availabilityWindows.length > 0 && <small>{resource.availabilityWindows.map((window) => `${formatHospitalDateTime(window.startsAt)} até ${formatHospitalDateTime(window.endsAt)}`).join("; ")}</small>}</label>)}
    {missing.map((id) => <p key={id}>{snapshots.find((snapshot) => snapshot.resourceId === id)?.name ?? "Recurso anterior não disponível nesta página"}<button type="button" onClick={() => onChange(selectedIds.filter((selected) => selected !== id))}>Remover vínculo anterior</button></p>)}
    {!page.loading && !resources.length && !page.error && <p>Nenhum recurso horário cadastrado neste setor.{canConfigure && <> <Link href="/admin/resources">Cadastrar recursos e disponibilidade</Link></>}</p>}{page.nextCursor && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>Carregar mais recursos do setor</button>}
    <p className="field-hint">A reserva usa IDs reais e valida disponibilidade, profissional elegível e conflito antes de salvar.</p>
  </fieldset>;
}
