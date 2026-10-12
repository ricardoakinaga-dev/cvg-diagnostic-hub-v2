"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HospitalServiceCatalogEntry, HospitalServicePage, ManagedUser, SessionResponse, SessionUser } from "@cvg/contracts";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";
import { useDepartments } from "./use-departments";
import { HospitalServiceForm, hospitalServiceKindLabels } from "./hospital-service-forms";
import { WorkActivityDisclosure } from "./work-activity-controls";
import { PlannerTargetReference } from "./planner-target-reference";
import { HospitalServiceImport } from "./hospital-service-import";

export function HospitalServiceConsole() {
  const [identity, setIdentity] = useState<SessionUser>(); const [items, setItems] = useState<HospitalServiceCatalogEntry[]>([]); const [users, setUsers] = useState<ManagedUser[]>([]);
  const [cursor, setCursor] = useState<string>(); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true); const [moreLoading, setMoreLoading] = useState(false); const [error, setError] = useState("");
  const generation = useRef(0); const identityId = useRef<string | undefined>(undefined);
  const directory = useDepartments(identity?.id, { includeInactive: true });
  const permissions = identity?.permissions ?? [];
  const canCreate = permissions.includes("service.catalog.manage") || permissions.includes("service.catalog.create");
  const canImport = canCreate || permissions.includes("service.catalog.update") || permissions.includes("service.catalog.deactivate");
  const load = useCallback(async () => {
    const version = ++generation.current; setLoading(true); setError("");
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      if (generation.current !== version) return;
      if (identityId.current !== session.user.id) { setItems([]); setUsers([]); setCursor(undefined); }
      identityId.current = session.user.id; setIdentity(session.user);
      const [page, people] = await Promise.allSettled([apiFetch<HospitalServicePage>("/hospital-services?includeInactive=true&limit=50"), session.user.permissions?.some((permission) => ["user.view", "user_role.manage"].includes(permission)) ? apiFetch<ManagedUser[]>("/users") : Promise.resolve([])]);
      if (generation.current !== version) return;
      if (page.status === "rejected") throw page.reason;
      setItems(page.value.items); setCursor(page.value.nextCursor); setTotal(page.value.total);
      setUsers(people.status === "fulfilled" ? people.value : []);
    } catch (cause) {
      if (generation.current !== version) return;
      if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { setIdentity(undefined); setItems([]); setUsers([]); setCursor(undefined); setTotal(0); }
      setError(getSafeErrorMessage(cause, "Não foi possível consultar os serviços hospitalares."));
    } finally { if (generation.current === version) setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); const refresh = () => void load(); window.addEventListener("cvg:realtime-updated", refresh); window.addEventListener("cvg:realtime-resync", refresh); return () => { window.clearTimeout(timer); generation.current += 1; window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", refresh); }; }, [load]);
  async function more() {
    if (!cursor || loading || moreLoading) return;
    const version = generation.current; setMoreLoading(true); setError("");
    try { const page = await apiFetch<HospitalServicePage>(`/hospital-services?includeInactive=true&limit=50&cursor=${encodeURIComponent(cursor)}`); if (generation.current !== version) return; setItems((current) => [...new Map([...current, ...page.items].map((entry) => [entry.id, entry])).values()]); setCursor(page.nextCursor); setTotal(page.total); }
    catch (cause) { if (generation.current !== version) return; if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { setIdentity(undefined); setItems([]); setUsers([]); setCursor(undefined); } setError(getSafeErrorMessage(cause, "Não foi possível carregar mais serviços. Tente novamente.")); }
    finally { if (generation.current === version) setMoreLoading(false); }
  }
  if (loading && !identity) return <LoadingState label="Carregando serviços hospitalares…" />;
  return <div><h1>Serviços hospitalares</h1><p>Capacidades de cuidado, procedimento, operação e diagnóstico. A definição do serviço é distinta de cada atividade executada.</p>{error && <ErrorState title="Catálogo indisponível" message={error} onRetry={load} retrying={loading} />}{directory.error && <p role="status">Parte do cadastro de setores está indisponível; novos vínculos exigem setor ativo.</p>}{canCreate && <HospitalServiceForm key={`create:${identity?.id}`} departments={directory.departments} users={users} permissions={permissions} refreshing={loading} onSaved={() => void load()} />}{canImport && <HospitalServiceImport onSaved={() => void load()} />}<PlannerTargetReference userId={identity?.id ?? ""} parameter="serviceId" prefix="hospital-service-" ids={items.map((entry) => entry.id)} loading={loading || moreLoading} error={error} nextCursor={cursor} onMore={() => void more()} /><p>{items.length} de {total} serviços carregados.</p>{items.map((entry) => entry.source === "HOSPITAL_SERVICE" ? <section id={`hospital-service-${entry.id}`} tabIndex={-1} key={`${identity?.id}:${entry.id}:${entry.version}`}><HospitalServiceForm service={entry} departments={directory.departments} users={users} permissions={permissions} refreshing={loading} onSaved={() => void load()} />{identity && <WorkActivityDisclosure user={identity} targetType="HOSPITAL_SERVICE" targetId={entry.id} readOnly={loading || Boolean(error)} />}</section> : <section id={`hospital-service-${entry.id}`} tabIndex={-1} className="panel" key={entry.id}><h3>{entry.name}</h3><p>{hospitalServiceKindLabels[entry.kind]} · {entry.departmentCode} · {entry.active ? "Ativo" : "Inativo"} · revisão {entry.version}</p><p>Definição mantida no catálogo de exames.</p><Link href="/admin/catalog">Abrir catálogo de exames</Link>{identity && <WorkActivityDisclosure user={identity} targetType="HOSPITAL_SERVICE" targetId={entry.id} readOnly={loading || Boolean(error)} />}</section>)}{cursor && <button type="button" disabled={loading || moreLoading} onClick={() => void more()}>{moreLoading ? "Carregando…" : "Carregar mais serviços"}</button>}</div>;
}
