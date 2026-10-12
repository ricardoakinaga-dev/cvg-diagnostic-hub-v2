"use client";

import Link from "next/link";
import type { RequestListEntry } from "./work-items/model";

export type CreatedRequest = RequestListEntry;

export function RequestCreatedNotice({ request, hiddenByFilters, filterLabels, onClear }: { request: CreatedRequest; hiddenByFilters?: boolean; filterLabels?: string[]; onClear?: () => void }) {
  return <div className="form-notice" role="status">
    <strong>Solicitação {request.requestCode ?? ""} criada.</strong>{" "}
    {request.id && <Link href={`/requests/${encodeURIComponent(request.id)}`}>Abrir solicitação</Link>}
    {hiddenByFilters && <p>Os filtros atuais ocultam os novos exames{filterLabels?.length ? `: ${filterLabels.join(" · ")}` : ""}.{" "}{onClear && <button type="button" className="link-button" onClick={onClear}>Limpar filtros e mostrar exames</button>}</p>}
  </div>;
}
