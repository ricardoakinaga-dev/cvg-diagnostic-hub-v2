"use client";

import { useEffect, useRef, useState } from "react";
import type { HospitalHisV4Catalog, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { apiFetch, getSafeErrorMessage } from "./api-client";

export function HospitalHisV4Discovery({ user, disabled }: { user: SessionUser; disabled: boolean }) {
  const [state, setState] = useState<{ userId: string; catalog?: HospitalHisV4Catalog; error: string; busy: boolean }>({ userId: "", error: "", busy: false });
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [user.id]);
  async function discover() {
    if (disabled || !user.permissions?.includes("integration.manage")) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setState({ userId: user.id, busy: true, error: "" });
    try { const catalog = await apiFetch<HospitalHisV4Catalog>("/hospital-integrations/his-v4/catalog", { signal: current.signal }); if (!current.signal.aborted) setState({ userId: user.id, catalog, error: "", busy: false }); }
    catch (cause) { if (!current.signal.aborted) setState({ userId: user.id, error: getSafeErrorMessage(cause, "Catálogo HIS v4 indisponível. Confira a configuração aprovada deste perfil."), busy: false }); }
  }
  if (!user.permissions?.includes("integration.manage")) return null;
  const visible = state.userId === user.id ? state : undefined;
  return <section className="panel"><h2>Perfil HIS v4</h2><p>O perfil HIS v4 usa catálogo anunciado e webhook v2, com configuração própria no servidor. A consulta solicita apenas o catálogo ao fornecedor; não transmite pacientes, documentos ou resultados.</p><p>Configuração ausente ou inválida mantém a consulta indisponível. Capacidades anunciadas não comprovam a homologação clínica desta instalação.</p><ActionButton disabled={disabled || visible?.busy} state={visible?.busy ? "pending" : "idle"} onClick={() => void discover()}>Consultar catálogo anunciado pelo HIS v4</ActionButton>{visible?.error && <p role="alert">{visible.error}</p>}{visible?.catalog && <><p>Perfil {visible.catalog.profile} · conta {visible.catalog.accountId} · observado em {formatHospitalDateTime(visible.catalog.observedAt)}.</p><p>Referência do contrato: {visible.catalog.contractReference}. Homologação externa ainda não comprovada.</p><ul>{visible.catalog.advertised.map((entry, index) => <li key={`${entry.family}:${index}`}><h3>{entry.family}{entry.provider ? ` · ${entry.provider}` : ""}</h3><p>Capacidades anunciadas: {entry.capabilities.join(", ") || "Nenhuma informada"}</p><ul>{entry.endpoints.map((endpoint, endpointIndex) => <li key={endpointIndex}><code>{endpoint}</code></li>)}</ul></li>)}</ul>{!visible.catalog.advertised.length && <p>Nenhuma capacidade anunciada no catálogo retornado.</p>}</>}</section>;
}
