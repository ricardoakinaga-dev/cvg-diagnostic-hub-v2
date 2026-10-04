"use client";

import { useCallback, useEffect, useState } from "react";
import type { DiagnosticService } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { RequestDialog } from "./dashboard";

export function QueueBoardRequestDialog({ departments, canCreatePatient, onClose, onCreated }: { departments: string[]; canCreatePatient: boolean; onClose: () => void; onCreated: () => void }) {
  const [services, setServices] = useState<DiagnosticService[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setServices(await apiFetch<DiagnosticService[]>("/diagnostic-services")); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível carregar os exames disponíveis.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  return <>
    {loading && <p role="status">Carregando exames disponíveis…</p>}
    <RequestDialog canCreatePatient={canCreatePatient} services={services.filter((service) => service.active && (departments.length === 0 || departments.includes(service.departmentCode)))} servicesError={error} onRetryServices={load} onClose={onClose} onCreated={onCreated} />
  </>;
}
