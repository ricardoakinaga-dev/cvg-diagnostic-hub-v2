"use client";

import { useState } from "react";
import type { HospitalTaskView, PlannerSearchResult } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { usePlannerPage } from "./use-planner";
import { PartialNotice } from "./feedback-states";

export interface PlannerActivitySelection { targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string; expectedTargetVersion: number; label: string }
/** Versions are read from the authorized source immediately before selection, never invented from search. */
export function PlannerActivityPicker({ userId, patientId, encounterId, onSelected }: { userId: string; patientId?: string; encounterId?: string; onSelected: (activity: PlannerActivitySelection) => void }) {
  const [query, setQuery] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const params = new URLSearchParams({ query: query.trim(), types: "HOSPITAL_TASK,DIAGNOSTIC_ITEM", limit: "25" }); if (patientId) params.set("patientId", patientId); if (encounterId) params.set("encounterId", encounterId);
  const page = usePlannerPage<PlannerSearchResult>(userId, `/planner/search?${params}`, query.trim().length >= 2);
  async function select(entry: PlannerSearchResult) {
    if (busy || !["HOSPITAL_TASK", "DIAGNOSTIC_ITEM"].includes(entry.type)) return;
    setBusy(true); setError("");
    try {
      const targetType = entry.type as PlannerActivitySelection["targetType"];
      const version = targetType === "HOSPITAL_TASK" ? (await apiFetch<HospitalTaskView>(`/hospital-tasks/${encodeURIComponent(entry.id)}`)).task.version : (await apiFetch<{ item: { version: number } }>(`/diagnostic-items/${encodeURIComponent(entry.id)}`)).item.version;
      onSelected({ targetType, targetId: entry.id, expectedTargetVersion: version, label: entry.label }); setQuery("");
    } catch (cause) { setError(getSafeErrorMessage(cause, "Esta atividade não está mais disponível. Atualize a busca.")); }
    finally { setBusy(false); }
  }
  return <fieldset><legend>Selecionar atividade existente</legend><label>Buscar atividade para vincular<input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}{error && <p role="alert">{error}</p>}<ul className="admin-list">{page.items.map((entry) => <li key={`${entry.type}:${entry.id}`}><button type="button" disabled={busy || Boolean(page.error)} onClick={() => void select(entry)}>{entry.type === "HOSPITAL_TASK" ? "Atividade" : "Exame"}: {entry.label}</button></li>)}</ul>{page.nextCursor && <ActionButton state={page.loadingMore ? "pending" : "idle"} tone="ghost" onClick={() => void page.loadMore()}>Mais atividades para vincular</ActionButton>}</fieldset>;
}
