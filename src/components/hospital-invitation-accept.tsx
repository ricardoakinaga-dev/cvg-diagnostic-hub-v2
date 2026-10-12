"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { HospitalInvitationAccepted, HospitalInvitationPreview } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { usePlannerCommand } from "./planner-command";

export function HospitalInvitationAccept() {
  const [token, setToken] = useState(""); const [preview, setPreview] = useState<HospitalInvitationPreview>(); const [error, setError] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [accepted, setAccepted] = useState(false); const command = usePlannerCommand();
  const initialToken = useRef<string | undefined>(undefined);
  useEffect(() => {
    const value = initialToken.current ?? window.location.hash.slice(1); initialToken.current = value; window.history.replaceState(null, "", window.location.pathname + window.location.search); const controller = new AbortController();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) { const timer = window.setTimeout(() => setError("Link de convite incompleto. Solicite um novo link à administração."), 0); return () => window.clearTimeout(timer); }
    void apiFetch<HospitalInvitationPreview>("/hospital-user-invitations/preview", { method: "POST", body: JSON.stringify({ token: value }), signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setToken(value); setPreview(result); } }).catch((cause) => { if (!controller.signal.aborted) setError(getSafeErrorMessage(cause, "Convite indisponível, expirado ou revogado.")); }); return () => controller.abort();
  }, []);
  if (accepted) return <main className="login-page"><h1>Convite aceito</h1><p>Sua conta foi criada. Entre para acessar o espaço autorizado.</p><Link href="/login">Ir para o login</Link></main>;
  return <main className="login-page"><h1>Aceitar convite</h1>{error && <p role="alert">{error}</p>}{preview && <><h2>{preview.institutionName}</h2><p>{preview.displayName} · {preview.maskedEmail} · válido até {formatHospitalDateTime(preview.expiresAt)}</p><form aria-label="Aceitar convite operacional" onSubmit={(event) => { event.preventDefault(); if (!token || password !== confirmation) { setError("As senhas devem ser iguais."); return; } setError(""); void command.execute<HospitalInvitationAccepted>("/hospital-user-invitations/accept", "POST", { token, password }).then((result) => { if (result?.accepted) { setPassword(""); setConfirmation(""); setToken(""); setPreview(undefined); setAccepted(true); } }); }}><label>Crie sua senha<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirme sua senha<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Aceitar e criar minha conta</ActionButton></form></>}{command.error && <p role="alert">{command.error}</p>}</main>;
}
