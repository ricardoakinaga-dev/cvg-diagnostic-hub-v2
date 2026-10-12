"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

interface ReferenceProps {
  userId: string; parameter: string; prefix: string; ids: string[];
  loading?: boolean; error?: string; nextCursor?: string; onMore?: () => void;
  onTarget?: (id: string) => void;
  onRequested?: () => void;
}

/** References use only rows already returned by the authorized listing. */
export function PlannerTargetReference(props: ReferenceProps) {
  return <Suspense fallback={null}><TargetReference {...props} /></Suspense>;
}
function TargetReference({ userId, parameter, prefix, ids, loading, error, nextCursor, onMore, onTarget, onRequested }: ReferenceProps) {
  const target = useSearchParams()?.get(parameter) ?? "";
  const source = `${userId}:${parameter}:${target}`;
  const focused = useRef(""); const initialized = useRef(""); const requested = useRef<{ source: string; cursors: Set<string> }>({ source: "", cursors: new Set() });
  const found = Boolean(target && ids.includes(target));
  useEffect(() => {
    if (!target) return;
    if (initialized.current !== source) { initialized.current = source; if (onRequested) { onRequested(); if (!found) return; } }
    if (loading || error) return;
    if (requested.current.source !== source) requested.current = { source, cursors: new Set() };
    if (found && focused.current !== source) {
      const node = document.getElementById(`${prefix}${target}`);
      if (!node) return;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      focused.current = source; node.focus(); node.scrollIntoView?.({ block: "center", behavior: "instant" }); onTarget?.(target);
    } else if (!found && nextCursor && onMore && requested.current.cursors.size < 5 && !requested.current.cursors.has(nextCursor)) {
      requested.current.cursors.add(nextCursor); onMore();
    }
  }, [target, source, found, loading, error, prefix, nextCursor, onMore, onTarget, onRequested]);
  if (!target || found) return null;
  return <p role="status">{loading ? "Localizando a referência no seu acesso…" : nextCursor ? "A referência ainda não está entre os registros carregados." : "A referência não está disponível nesta visão ou no seu acesso atual."}{!loading && !error && nextCursor && onMore && <button type="button" onClick={onMore}>Continuar procurando a referência</button>}</p>;
}
