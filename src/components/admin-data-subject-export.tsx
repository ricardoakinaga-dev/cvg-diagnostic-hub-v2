"use client";

import { useState, type FormEvent } from "react";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

interface PatientDataExportSummary { patient: { externalId: string }; requests: Array<{ archived: boolean }> }

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * PROD-502 (D-048): the LGPD export of a patient's records, asked by the tutor through the hospital's data protection
 * officer. Only an ADMIN sees it; the password is confirmed again right before the export (the server refuses an
 * export without a fresh step-up) and the file is downloaded, never shown on screen. Every export is audited.
 */
export function DataSubjectExportPanel() {
  const [externalId, setExternalId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record = externalId.trim();
    if (!EXTERNAL_ID.test(record)) { setError("Informe o número do prontuário: letras, números, ponto, hífen ou sublinhado."); return; }
    setBusy(true); setError(""); setMessage("");
    let confirmed = false;
    try {
      await apiFetch("/session/reauth", { method: "POST", body: JSON.stringify({ password }) });
      confirmed = true; setPassword("");
      const data = await apiFetch<PatientDataExportSummary>(`/data-subject-exports?externalId=${encodeURIComponent(record)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `titular-${data.patient.externalId}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const archived = data.requests.filter((request) => request.archived).length;
      setMessage(`Exportação de ${data.patient.externalId} gerada e registrada na auditoria: ${data.requests.length} solicitação(ões), ${archived} arquivada(s). Entregue o arquivo ao encarregado de dados.`);
      setExternalId("");
    } catch (cause) {
      setError(getSafeErrorMessage(cause, confirmed ? "Não foi possível gerar a exportação." : "Não foi possível confirmar sua senha."));
    } finally { setBusy(false); }
  }

  return <details className="admin-create"><summary><Icon name="table" size={14} /> Exportar dados do titular (LGPD)</summary>
    <form className="admin-create-form" onSubmit={(event) => void submit(event)}>
      <p className="page-lede">Para um pedido do tutor recebido pelo encarregado de dados. Gera um arquivo JSON com o cadastro, os atendimentos e os exames do paciente, ativos e arquivados, sem dados da equipe. A exportação fica registrada na auditoria. Exclusão: só no fim do prazo legal de guarda (veja o procedimento de pedidos do titular).</p>
      <label>Número do prontuário<input value={externalId} onChange={(event) => setExternalId(event.target.value)} maxLength={100} autoComplete="off" required /></label>
      <label>Sua senha (confirmação)<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={200} autoComplete="current-password" required /></label>
      <ActionButton type="submit" tone="ghost" state={busy ? "pending" : "idle"} disabled={busy || !externalId.trim() || !password}>{busy ? "Exportando…" : "Exportar"}</ActionButton>
      {error && <p className="form-alert" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </form>
  </details>;
}
