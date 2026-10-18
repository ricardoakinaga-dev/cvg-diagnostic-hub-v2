"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticService, QueueItem, SessionResponse, SessionUser } from "@cvg/contracts";
import { ApiClientError, apiFetch, apiFetchWithMeta, getSafeErrorMessage } from "@/components/api-client";
import { fromQueueItem, fromRequests, mergeWorkItems, type RequestListEntry, type WorkItem } from "./model";

const PAGE_LIMIT = 50;

function nextCursor(meta: Record<string, unknown>): string | undefined {
  return typeof meta.nextCursor === "string" && meta.nextCursor.length > 0 ? meta.nextCursor : undefined;
}

async function loadPage<T>(path: string, cursor?: string): Promise<{ data: T[]; cursor?: string }> {
  const separator = path.includes("?") ? "&" : "?";
  const result = await apiFetchWithMeta<T[]>(`${path}${separator}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  return { data: result.data, cursor: nextCursor(result.meta) };
}
type Continuation = { path: string; cursor: string; department?: string };

/** Departments whose queues this user works, besides what requests expose. */
export function workedDepartments(user: SessionUser, catalog: readonly Pick<DiagnosticService, "departmentCode">[] = []): string[] {
  if (user.role === "SUPERADMIN") return [...new Set(catalog.map((service) => service.departmentCode))];
  if (user.role === "MANAGER") return Array.from(new Set([user.departmentCode, ...(user.managedDepartmentCodes ?? [])]));
  if (["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(user.role)) return [user.departmentCode];
  return [];
}

export interface WorkItemsState {
  user: SessionUser | null;
  items: WorkItem[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  partial: string;
  truncated: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  paginationError: string;
  reload: () => Promise<void>;
  /** Apply a local update only to the expected server version, when supplied. */
  patch: (id: string, update: Partial<WorkItem>, expectedVersion?: number) => void;
}

export function useWorkItems(): WorkItemsState {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [continuations, setContinuations] = useState<Continuation[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState("");
  const version = useRef(0);
  const loaded = useRef(false);
  const identity = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const current = ++version.current;
    if (loaded.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    setLoadingMore(false);
    setPaginationError("");
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      if (version.current !== current) return;
      if (identity.current !== session.user.id) {
        setItems([]);
        setContinuations([]);
        setTruncated(false);
        setPartial("");
        loaded.current = false;
      }
      identity.current = session.user.id;
      // Session permissions should be available while the examination list loads.
      setUser(session.user);
      const may = (permission: "request.list" | "queue.view" | "service.catalog.view") => session.user.permissions === undefined || session.user.permissions.includes(permission);
      const mayRequests = may("request.list"); const mayQueues = may("queue.view");
      const catalog = mayQueues && may("service.catalog.view") && session.user.role === "SUPERADMIN" ? await apiFetch<DiagnosticService[]>("/diagnostic-services?includeInactive=true") : [];
      if (version.current !== current) return;
      if (!Array.isArray(catalog)) throw new Error("CATALOG_DIRECTORY_INVALID");
      const departments = mayQueues ? workedDepartments(session.user, catalog) : [];
      const [requests, ...queues] = await Promise.allSettled([
        mayRequests ? loadPage<RequestListEntry>("/diagnostic-requests") : Promise.resolve({ data: [] as RequestListEntry[], cursor: undefined }),
        ...departments.map(async (code) => ({ code, page: await loadPage<QueueItem>(`/queues/${encodeURIComponent(code)}/items`) }))
      ]);
      if (version.current !== current) return;
      if (requests.status === "rejected") throw requests.reason;
      const refusal = queues.find((result) => result.status === "rejected" && result.reason instanceof ApiClientError && [401, 403, 404].includes(result.reason.status));
      if (refusal?.status === "rejected") throw refusal.reason;
      const enriched = queues.flatMap((result) => result.status === "fulfilled" ? result.value.page.data.map((item) => fromQueueItem(item, result.value.code)) : []);
      setItems(mergeWorkItems(fromRequests(requests.value.data), enriched));
      const next: Continuation[] = requests.value.cursor ? [{ path: "/diagnostic-requests", cursor: requests.value.cursor }] : [];
      for (const queue of queues) if (queue.status === "fulfilled" && queue.value.page.cursor) next.push({ path: `/queues/${encodeURIComponent(queue.value.code)}/items`, cursor: queue.value.page.cursor, department: queue.value.code });
      setContinuations(next);
      setTruncated(next.length > 0);
      setPartial(queues.some((result) => result.status === "rejected") ? "Parte das filas do setor não respondeu; próximas ações podem estar incompletas." : "");
      loaded.current = true;
    } catch (cause) {
      if (version.current === current) {
        if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { setUser(null); setItems([]); setContinuations([]); setTruncated(false); setPartial(""); loaded.current = false; identity.current = null; }
        setError(getSafeErrorMessage(cause, "Não foi possível carregar os exames."));
      }
    } finally {
      if (version.current === current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loading || refreshing || loadingMore || continuations.length === 0) return;
    const current = version.current;
    setLoadingMore(true);
    setPaginationError("");
    const results = await Promise.allSettled(continuations.map(async (entry) => {
      const page = await loadPage<RequestListEntry | QueueItem>(entry.path, entry.cursor);
      if (page.cursor === entry.cursor) throw new Error("PAGE_CURSOR_NOT_ADVANCING");
      return { entry, page };
    }));
    if (version.current !== current) return;
    const refusal = results.find((result) => result.status === "rejected" && result.reason instanceof ApiClientError && [401, 403, 404].includes(result.reason.status));
    if (refusal?.status === "rejected") {
      setUser(null); setItems([]); setContinuations([]); setTruncated(false); setPartial(""); setLoadingMore(false); loaded.current = false; identity.current = null;
      setError(getSafeErrorMessage(refusal.reason, "Não foi possível carregar os exames."));
      return;
    }
    const additions: WorkItem[] = [];
    const remaining: Continuation[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") { remaining.push(continuations[index]); return; }
      const { entry, page } = result.value;
      additions.push(...(entry.department ? (page.data as QueueItem[]).map((item) => fromQueueItem(item, entry.department!)) : fromRequests(page.data as RequestListEntry[])));
      if (page.cursor) remaining.push({ ...entry, cursor: page.cursor });
    });
    setItems((previous) => mergeWorkItems(previous, additions));
    setContinuations(remaining);
    setTruncated(remaining.length > 0);
    if (results.some((result) => result.status === "rejected")) setPaginationError("Parte dos exames não pôde ser carregada. Os itens anteriores foram preservados; tente novamente.");
    setLoadingMore(false);
  }, [continuations, loading, loadingMore, refreshing]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    const refresh = () => { void reload(); };
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => {
      version.current += 1;
      window.clearTimeout(timer);
      window.removeEventListener("cvg:realtime-updated", refresh);
      window.removeEventListener("cvg:realtime-resync", refresh);
    };
  }, [reload]);

  const patch = useCallback((id: string, update: Partial<WorkItem>, expectedVersion?: number) => {
    setItems((current) => current.map((item) => item.id === id && (expectedVersion === undefined || item.version === expectedVersion) ? { ...item, ...update } : item));
  }, []);

  return { user, items, loading, refreshing, error, partial, truncated, loadingMore, loadMore, paginationError, reload, patch };
}
