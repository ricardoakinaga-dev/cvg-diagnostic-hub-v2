"use client";

import { useCallback, useEffect, useState, type SetStateAction } from "react";
const NO_LEGACY_KEYS: readonly string[] = [];

export function queuePreferenceKey(userId: string, view: string): string {
  return `cvg.queue.preferences.v2:${encodeURIComponent(userId)}:${encodeURIComponent(view)}`;
}

/** Anonymous v1 preferences have no provable owner; discard them instead of attributing them to the next login. */
export function readQueuePreferences<T>(userId: string, view: string, fallback: T, normalize: (value: unknown) => T, legacyKeys: readonly string[] = []): T {
  try {
    for (const key of legacyKeys) window.localStorage.removeItem(key);
    const raw = window.localStorage.getItem(queuePreferenceKey(userId, view));
    if (!raw) return fallback;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return fallback;
    const envelope = record as Record<string, unknown>;
    if (envelope.version !== 2 || envelope.userId !== userId || envelope.view !== view) return fallback;
    return normalize(envelope.value);
  } catch { return fallback; }
}

export function useQueuePreferences<T>(userId: string | undefined, view: string, fallback: T, normalize: (value: unknown) => T, legacyKeys: readonly string[] = NO_LEGACY_KEYS) {
  const identity = userId ? queuePreferenceKey(userId, view) : "";
  const [state, setState] = useState<{ identity: string; value: T }>({ identity: "", value: fallback });
  // The previous person's/route's choices are never rendered while the new identity loads.
  const value = identity && state.identity === identity ? state.value : fallback;
  useEffect(() => {
    const timer = window.setTimeout(() => setState({ identity, value: userId ? readQueuePreferences(userId, view, fallback, normalize, legacyKeys) : fallback }), 0);
    return () => window.clearTimeout(timer);
  }, [identity, userId, view, fallback, normalize, legacyKeys]);
  const update = useCallback((next: SetStateAction<T>) => {
    if (!userId) return;
    setState((current) => {
      const previous = current.identity === identity ? current.value : readQueuePreferences(userId, view, fallback, normalize, legacyKeys);
      const normalized = normalize(typeof next === "function" ? (next as (value: T) => T)(previous) : next);
      try { window.localStorage.setItem(identity, JSON.stringify({ version: 2, userId, view, value: normalized })); } catch { /* Storage is an optional convenience. */ }
      return { identity, value: normalized };
    });
  }, [identity, userId, view, fallback, normalize, legacyKeys]);
  return [value, update] as const;
}
