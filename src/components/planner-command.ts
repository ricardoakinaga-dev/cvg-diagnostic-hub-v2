"use client";

import { useRef, useState } from "react";
import { apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";

/** One intent keeps its idempotency key after an ambiguous failure; changed payloads start a new intent. */
export function usePlannerCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const intent = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  async function execute<T>(path: string, method: string, body: object): Promise<T | undefined> {
    if (pending.current) return undefined;
    pending.current = true; setBusy(true); setError("");
    const serialized = JSON.stringify(body);
    const fingerprint = `${method}:${path}:${serialized}`;
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: createClientUniqueId() };
    try {
      const result = await apiFetch<T>(path, { method, headers: { "idempotency-key": intent.current.key }, body: serialized });
      intent.current = undefined; return result;
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar. Confira os dados e tente novamente.")); return undefined; }
    finally { pending.current = false; setBusy(false); }
  }
  return { execute, busy, error };
}
