"use client";

import { useCallback, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDialogFocus } from "./use-dialog-focus";

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "default" | "danger";
}

interface PendingConfirmation extends ConfirmOptions {
  readonly resolve: (confirmed: boolean) => void;
  readonly opener: HTMLElement | null;
}

/**
 * Replaces the browser-native window.confirm with the same modal pattern used by the other dialogs
 * (focus trap, Escape to cancel, focus returned to the opener). `confirm()` resolves to the choice,
 * and `dialog` must be rendered once by the component that calls it.
 */
export function useConfirm(): { confirm: (options: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    const active = document.activeElement;
    setPending({ ...options, resolve, opener: active instanceof HTMLElement ? active : null });
  }), []);
  const settle = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);
  return { confirm, dialog: pending ? <ConfirmDialog request={pending} onSettle={settle} /> : null };
}

function ConfirmDialog({ request, onSettle }: { request: PendingConfirmation; onSettle: (confirmed: boolean) => void }) {
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(request.opener) as RefObject<HTMLElement | null>;
  useDialogFocus(dialogRef, () => onSettle(false), cancelRef, openerRef);
  return (
    <div className="dialog-backdrop">
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{request.title}</h2>
        <p>{request.message}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="button button-ghost" onClick={() => onSettle(false)}>{request.cancelLabel ?? "Cancelar"}</button>
          <button type="button" className={request.tone === "danger" ? "button button-danger-ghost" : "button button-primary"} onClick={() => onSettle(true)}>{request.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
