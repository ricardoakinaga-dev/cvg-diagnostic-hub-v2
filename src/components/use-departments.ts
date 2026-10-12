"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Department, DiagnosticService } from "@cvg/contracts";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";

export interface DepartmentOption { code: string; name: string; active: boolean; type?: Department["type"] }

/** Unregistered historical codes stay readable; they are never offered for a new binding. */
export function departmentOptions(departments: Department[], extraCodes: string[] = []): DepartmentOption[] {
  const options = new Map<string, DepartmentOption>();
  for (const department of departments) options.set(department.code, { code: department.code, name: department.name, active: department.active, type: department.type });
  for (const code of extraCodes.filter(Boolean)) if (!options.has(code)) options.set(code, { code, name: code, active: false });
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function useDepartments(userId?: string, { includeInactive = false, catalog = false }: { includeInactive?: boolean; catalog?: boolean } = {}) {
  const scope = `${userId ?? ""}:${includeInactive}:${catalog}`;
  const [state, setState] = useState<{ scope: string; departments: Department[]; services: DiagnosticService[]; loading: boolean; error: string }>({ scope: "", departments: [], services: [], loading: false, error: "" });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!userId) return;
    setState((previous) => ({ scope, departments: previous.scope === scope ? previous.departments : [], services: previous.scope === scope ? previous.services : [], loading: true, error: "" }));
    try {
      const [departments, services] = await Promise.allSettled([
        apiFetch<Department[]>(`/departments${includeInactive ? "?includeInactive=true" : ""}`),
        catalog ? apiFetch<DiagnosticService[]>("/diagnostic-services") : Promise.resolve<DiagnosticService[]>([])
      ]);
      if ((departments.status === "fulfilled" && !Array.isArray(departments.value)) || (services.status === "fulfilled" && !Array.isArray(services.value))) throw new Error("Invalid department directory");
      const failures = [departments, services].filter((result) => result.status === "rejected");
      const sessionFailure = failures.find((result) => result.reason instanceof ApiClientError && result.reason.status === 401);
      if (sessionFailure) throw sessionFailure.reason;
      if (generation.current !== current) return;
      const unavailable = (result: PromiseRejectedResult) => result.reason instanceof ApiClientError && [403, 404].includes(result.reason.status);
      setState((previous) => ({
        scope, loading: false,
        departments: departments.status === "fulfilled" ? departments.value : !unavailable(departments) && previous.scope === scope ? previous.departments : [],
        services: services.status === "fulfilled" ? services.value : !unavailable(services) && previous.scope === scope ? previous.services : [],
        error: failures.length ? getSafeErrorMessage(failures[0].reason, "Parte do cadastro de setores está indisponível.") : ""
      }));
    } catch (cause) {
      if (generation.current !== current) return;
      const denied = cause instanceof ApiClientError && [401, 403, 404].includes(cause.status);
      setState((previous) => ({ scope, departments: !denied && previous.scope === scope ? previous.departments : [], services: !denied && previous.scope === scope ? previous.services : [], loading: false, error: getSafeErrorMessage(cause, "Não foi possível carregar os setores autorizados.") }));
    }
  }, [userId, scope, includeInactive, catalog]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    const update = () => { void reload(); };
    window.addEventListener("cvg:departments-updated", update);
    window.addEventListener("cvg:realtime-updated", update);
    window.addEventListener("cvg:realtime-resync", update);
    return () => { window.clearTimeout(timer); generation.current += 1; window.removeEventListener("cvg:departments-updated", update); window.removeEventListener("cvg:realtime-updated", update); window.removeEventListener("cvg:realtime-resync", update); };
  }, [reload]);
  const visible = state.scope === scope && userId ? state : { departments: [], services: [], loading: Boolean(userId), error: "" };
  return { ...visible, reload };
}
