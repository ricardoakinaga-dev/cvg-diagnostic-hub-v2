"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HospitalTaskOptions, SessionResponse, SessionUser } from "@cvg/contracts";
import { ApiClientError, apiFetch, apiFetchWithMeta, getSafeErrorMessage } from "./api-client";

export function usePlannerIdentity() {
  const [user, setUser] = useState<SessionUser>();
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => { const current = ++sequence.current; void apiFetch<SessionResponse>("/session/me", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted && current === sequence.current) { setUser(result.user); setError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted && current === sequence.current) { setUser(undefined); setError(getSafeErrorMessage(cause, "Não foi possível consultar seu acesso.")); } }); };
    load(); window.addEventListener("cvg:realtime-resync", load);
    return () => { controller.abort(); window.removeEventListener("cvg:realtime-resync", load); };
  }, []);
  return { user, error };
}

export function usePlannerOptions(user?: SessionUser) {
  const [resource, setResource] = useState<{ userId: string; data?: HospitalTaskOptions; error: string }>({ userId: "", error: "" });
  const enabled = user?.permissions?.includes("hospital_task.create") === true;
  useEffect(() => {
    if (!user || !enabled) return;
    const userId = user.id; const controller = new AbortController();
    void apiFetch<HospitalTaskOptions>("/hospital-tasks/options", { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setResource({ userId, data, error: "" }); }).catch((cause: unknown) => { if (!controller.signal.aborted) setResource({ userId, error: getSafeErrorMessage(cause, "Não foi possível carregar as opções para criação.") }); });
    return () => controller.abort();
  }, [user, enabled]);
  return resource.userId === user?.id && enabled ? resource : { data: undefined, error: "" };
}

interface Page<T> { items: T[]; total: number; unread?: number; limit: number; nextCursor?: string }
interface PageState<T> { scope: string; items: T[]; total: number; unread?: number; nextCursor?: string; loading: boolean; loadingMore: boolean; error: string }
const isDenied = (cause: unknown) => cause instanceof ApiClientError && [401, 403, 404].includes(cause.status);
async function readPage<T>(path: string, envelopeItems: boolean): Promise<Page<T>> {
  if (!envelopeItems) return apiFetch<Page<T>>(path);
  const { data, meta } = await apiFetchWithMeta<T[]>(path);
  return { items: data, total: typeof meta.total === "number" ? meta.total : data.length, limit: typeof meta.limit === "number" ? meta.limit : 50, ...(typeof meta.nextCursor === "string" ? { nextCursor: meta.nextCursor } : {}) };
}

/** Cursor reads remain scoped to identity and criteria; an older response cannot restore revoked data. */
interface PlannerPageEntry { id?: string; type?: string; targetType?: string; task?: { id: string }; plan?: { id: string }; shift?: { id: string }; handoff?: { id: string }; template?: { id: string }; recurrence?: { id: string }; comment?: { id: string }; notification?: { id: string }; preference?: { id: string } }
const entryKey = (entry: PlannerPageEntry) => `${entry.type ?? entry.targetType ?? ""}:${entry.task?.id ?? entry.plan?.id ?? entry.shift?.id ?? entry.handoff?.id ?? entry.template?.id ?? entry.recurrence?.id ?? entry.comment?.id ?? entry.notification?.id ?? entry.preference?.id ?? entry.id}`;
export function usePlannerPage<T extends PlannerPageEntry>(userId: string | undefined, path: string, enabled = true, envelopeItems = false) {
  const scope = userId && enabled ? `${userId}:${path}:${envelopeItems}` : "";
  const [state, setState] = useState<PageState<T>>({ scope: "", items: [], total: 0, loading: false, loadingMore: false, error: "" });
  const generation = useRef(0);
  const loadingMoreRef = useRef(false);
  const invalidate = useCallback(() => { generation.current += 1; }, []);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!scope) return;
    loadingMoreRef.current = false;
    setState((previous) => ({ scope, items: previous.scope === scope ? previous.items : [], total: previous.scope === scope ? previous.total : 0, unread: previous.scope === scope ? previous.unread : undefined, loading: true, loadingMore: false, error: "" }));
    try {
      const page = await readPage<T>(path, envelopeItems);
      if (generation.current === current) setState({ scope, ...page, loading: false, loadingMore: false, error: "" });
    } catch (cause) {
      if (generation.current === current) setState((previous) => ({ scope, items: !isDenied(cause) && previous.scope === scope ? previous.items : [], total: !isDenied(cause) && previous.scope === scope ? previous.total : 0, unread: !isDenied(cause) && previous.scope === scope ? previous.unread : undefined, loading: false, loadingMore: false, error: getSafeErrorMessage(cause, "Não foi possível carregar esta visão. Atualize antes de operar.") }));
    }
  }, [path, scope, envelopeItems]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    const update = () => { void reload(); };
    window.addEventListener("cvg:realtime-updated", update); window.addEventListener("cvg:realtime-resync", update);
    return () => { window.clearTimeout(timer); invalidate(); window.removeEventListener("cvg:realtime-updated", update); window.removeEventListener("cvg:realtime-resync", update); };
  }, [reload, invalidate]);
  const visible = scope && state.scope === scope ? state : { items: [], total: 0, unread: undefined, nextCursor: undefined, loading: Boolean(scope), loadingMore: false, error: "" };
  async function loadMore() {
    if (!scope || !visible.nextCursor || visible.loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true; const current = generation.current;
    setState((previous) => ({ ...previous, loadingMore: true, error: "" }));
    try {
      const page = await readPage<T>(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(visible.nextCursor)}`, envelopeItems);
      if (generation.current !== current) return;
      setState((previous) => {
        const entries = new Map(previous.items.map((entry) => [entryKey(entry), entry]));
        for (const entry of page.items) entries.set(entryKey(entry), entry);
        return { scope, items: [...entries.values()], total: page.total, unread: page.unread, nextCursor: page.nextCursor, loading: false, loadingMore: false, error: "" };
      });
    } catch (cause) {
      if (generation.current === current) setState((previous) => ({ ...previous, ...(isDenied(cause) ? { items: [], total: 0, unread: undefined, nextCursor: undefined } : {}), loadingMore: false, error: getSafeErrorMessage(cause, "Não foi possível carregar a continuação.") }));
    } finally { if (generation.current === current) loadingMoreRef.current = false; }
  }
  return { ...visible, reload, loadMore };
}
