"use client";

import { useRef, useState } from "react";
import type { HospitalTaskAttachmentSession, HospitalTaskPublicAttachment, HospitalTaskView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";
import { usePlannerCommand } from "./planner-command";
import { usePlannerPage } from "./use-planner";
import { PartialNotice } from "./feedback-states";

export function attachmentUploadPath(session: HospitalTaskAttachmentSession): string {
  const expected = `/api/v1/hospital-task-attachments/${encodeURIComponent(session.attachment.id)}/content`;
  if (session.uploadUrl !== expected) throw new Error("Destino de envio inválido. Atualize a atividade antes de tentar novamente.");
  return expected.slice("/api/v1".length);
}
async function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("Arquivo inválido.")); reader.onerror = () => reject(new Error("Não foi possível ler o arquivo.")); reader.readAsArrayBuffer(file); });
}
export function HospitalTaskAttachments({ user, view, readOnly = false }: { user: SessionUser; view: HospitalTaskView; readOnly?: boolean }) {
  const may = (permission: "hospital_task.attachment.view" | "hospital_task.attachment.upload" | "hospital_task.attachment.download") => user.permissions?.includes(permission) === true && view.permissions.includes(permission);
  const page = usePlannerPage<HospitalTaskPublicAttachment>(user.id, `/hospital-tasks/${view.task.id}/attachments?limit=50`, may("hospital_task.attachment.view"));
  if (!may("hospital_task.attachment.view")) return null;
  return <section className="panel"><h2>Anexos da atividade</h2><p>Arquivos desta atividade não compõem uma versão de laudo. Downloads ficam disponíveis após a verificação de segurança e a finalização.</p>{page.error && <PartialNotice message={page.error} onRetry={page.reload} />}<ul>{page.items.map((file) => <li key={file.id}><strong>{file.safeName}</strong> · {Math.ceil(file.sizeBytes / 1024)} KB · {{ PENDING: "Verificação pendente", CLEAN: "Verificação concluída", QUARANTINED: "Em quarentena", FAILED: "Falha na verificação" }[file.scanStatus]} · {{ INITIATED: "Envio iniciado", UPLOADED: "Conteúdo recebido", FINALIZED: "Finalizado" }[file.uploadStatus]}{may("hospital_task.attachment.download") && !page.error && file.scanStatus === "CLEAN" && file.uploadStatus === "FINALIZED" && <a href={`/api/v1/hospital-task-attachments/${encodeURIComponent(file.id)}/content`} download={file.safeName}>Baixar {file.safeName}</a>}</li>)}</ul>{page.nextCursor && <button type="button" disabled={page.loadingMore} onClick={() => void page.loadMore()}>Carregar mais anexos</button>}{may("hospital_task.attachment.upload") && <TaskAttachmentUpload key={`${user.id}:${view.task.id}`} view={view} disabled={readOnly || Boolean(page.error)} onSaved={() => void page.reload()} />}</section>;
}
function TaskAttachmentUpload({ view, disabled, onSaved }: { view: HospitalTaskView; disabled: boolean; onSaved: () => void }) {
  const [file, setFile] = useState<File>(); const [busy, setBusy] = useState(false); const pending = useRef(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const command = usePlannerCommand();
  const intent = useRef<{ file: File; session: HospitalTaskAttachmentSession; attachment: HospitalTaskPublicAttachment; uploadKey: string } | undefined>(undefined);
  async function upload() {
    if (!file || disabled || pending.current) return;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) { setError("Escolha PDF, JPEG ou PNG, de 1 byte a 10 MB."); return; }
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const bytes = await readFile(file);
      if (intent.current?.file !== file) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes); const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const session = await command.execute<HospitalTaskAttachmentSession>(`/hospital-tasks/${view.task.id}/attachments/upload-sessions`, "POST", { filename: file.name, mimeType: file.type, sizeBytes: file.size, checksum, expectedVersion: view.task.version });
        if (!session) return; intent.current = { file, session, attachment: session.attachment, uploadKey: createClientUniqueId() };
      }
      const current = intent.current; const path = attachmentUploadPath(current.session);
      if (current.attachment.uploadStatus === "INITIATED") {
        const response = await apiFetch<{ attachment: HospitalTaskPublicAttachment }>(path, { method: "PUT", headers: { "content-type": "application/octet-stream", "idempotency-key": current.uploadKey }, body: bytes }); current.attachment = response.attachment;
      }
      if (current.attachment.uploadStatus !== "FINALIZED") {
        const response = await command.execute<{ attachment: HospitalTaskPublicAttachment }>(`/hospital-task-attachments/${current.attachment.id}/finalize`, "POST", { expectedVersion: current.attachment.version });
        if (!response) return; current.attachment = response.attachment;
      }
      setNotice(current.attachment.scanStatus === "CLEAN" ? "Arquivo finalizado e verificado." : "Envio registrado. Consulte o estado real da verificação antes do download."); setFile(undefined); intent.current = undefined; onSaved();
    } catch (cause) { setError(getSafeErrorMessage(cause, cause instanceof Error ? cause.message : "Não foi possível enviar o anexo.")); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div><label>Anexar PDF, JPEG ou PNG · até 10 MB<input type="file" accept="application/pdf,image/jpeg,image/png" disabled={disabled || busy} onChange={(event) => { setFile(event.currentTarget.files?.[0]); intent.current = undefined; setNotice(""); }} /></label><ActionButton disabled={!file || disabled} state={busy ? "pending" : "idle"} onClick={() => void upload()}>Enviar ou retomar anexo</ActionButton>{(error || command.error) && <p role="alert">{error || command.error}</p>}{notice && <p role="status">{notice}</p>}</div>;
}
