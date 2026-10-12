"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";

/** Detail reads and writes are isolated by identity and source, including a response from an older fetch. */
export function usePlannerResource<T>(userId: string | undefined, path: string, enabled = true) {
  const scope = userId && enabled ? `${userId}:${path}` : "";
  const [state, setState] = useState<{ scope: string; data?: T; loading: boolean; error: string }>({ scope: "", loading: false, error: "" });
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!scope) return;
    setState((previous) => ({ scope, data: previous.scope === scope ? previous.data : undefined, loading: true, error: "" }));
    try {
      const data = await apiFetch<T>(path);
      if (current === generation.current) setState({ scope, data, loading: false, error: "" });
    } catch (cause) {
      if (current === generation.current) setState((previous) => ({ scope, data: cause instanceof ApiClientError && [401, 403, 404].includes(cause.status) ? undefined : previous.scope === scope ? previous.data : undefined, loading: false, error: getSafeErrorMessage(cause, "Não foi possível consultar este conteúdo. Atualize antes de operar.") }));
    }
  }, [scope, path]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    const update = () => { void reload(); };
    window.addEventListener("cvg:realtime-updated", update); window.addEventListener("cvg:realtime-resync", update);
    return () => { window.clearTimeout(timer); invalidate(); window.removeEventListener("cvg:realtime-updated", update); window.removeEventListener("cvg:realtime-resync", update); };
  }, [reload, invalidate]);
  const visible = scope && state.scope === scope ? state : { data: undefined, loading: Boolean(scope), error: "" };
  function saved(data: T) { generation.current++; setState({ scope, data, loading: false, error: "" }); }
  return { ...visible, reload, saved };
}
