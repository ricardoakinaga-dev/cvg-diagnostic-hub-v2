"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueItem, SessionResponse, SessionUser } from "@cvg/contracts";
import { apiFetch, apiFetchWithMeta, getSafeErrorMessage } from "@/components/api-client";
import { fromQueueItem, fromRequests, mergeWorkItems, type RequestListEntry, type WorkItem } from "./model";

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

function nextCursor(meta: Record<string, unknown>): string | undefined {
  return typeof meta.nextCursor === "string" && meta.nextCursor.length > 0 ? meta.nextCursor : undefined;
}

async function loadAllPages<T>(path: string): Promise<{ data: T[]; truncated: boolean }> {
  const data: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await apiFetchWithMeta<T[]>(`${path}${separator}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    data.push(...result.data);
    cursor = nextCursor(result.meta);
    if (!cursor) return { data, truncated: false };
  }
  return { data, truncated: true };
}

/** Departments whose queues this user works, besides what requests expose. */
export function workedDepartments(user: SessionUser): string[] {
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
  const version = useRef(0);
  const loaded = useRef(false);

  const reload = useCallback(async () => {
    const current = ++version.current;
    if (loaded.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      if (version.current !== current) return;
      // Session permissions should be available while the examination list loads.
      setUser(session.user);
      const departments = workedDepartments(session.user);
      const [requests, ...queues] = await Promise.allSettled([
        loadAllPages<RequestListEntry>("/diagnostic-requests"),
        ...departments.map(async (code) => ({ code, page: await loadAllPages<QueueItem>(`/queues/${encodeURIComponent(code)}/items`) }))
      ]);
      if (version.current !== current) return;
      if (requests.status === "rejected") throw requests.reason;
      const enriched = queues.flatMap((result) => result.status === "fulfilled" ? result.value.page.data.map((item) => fromQueueItem(item, result.value.code)) : []);
      setItems(mergeWorkItems(fromRequests(requests.value.data), enriched));
      setTruncated(requests.value.truncated || queues.some((result) => result.status === "fulfilled" && result.value.page.truncated));
      setPartial(queues.some((result) => result.status === "rejected") ? "Parte das filas do setor não respondeu; próximas ações podem estar incompletas." : "");
      loaded.current = true;
    } catch (cause) {
      if (version.current === current) setError(getSafeErrorMessage(cause, "Não foi possível carregar os exames."));
    } finally {
      if (version.current === current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    const refresh = () => { void reload(); };
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("cvg:realtime-updated", refresh);
      window.removeEventListener("cvg:realtime-resync", refresh);
    };
  }, [reload]);

  const patch = useCallback((id: string, update: Partial<WorkItem>, expectedVersion?: number) => {
    setItems((current) => current.map((item) => item.id === id && (expectedVersion === undefined || item.version === expectedVersion) ? { ...item, ...update } : item));
  }, []);

  return { user, items, loading, refreshing, error, partial, truncated, reload, patch };
}
