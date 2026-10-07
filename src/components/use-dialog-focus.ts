import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}

const backgroundIsolation = new WeakMap<HTMLElement, { count: number; wasInert: boolean }>();

function isolateBackground(dialog: HTMLElement): () => void {
  const isolated: HTMLElement[] = [];
  for (let branch: HTMLElement | null = dialog; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      const current = backgroundIsolation.get(sibling) ?? { count: 0, wasInert: sibling.hasAttribute("inert") };
      current.count += 1;
      backgroundIsolation.set(sibling, current);
      sibling.setAttribute("inert", "");
      isolated.push(sibling);
    }
  }
  return () => {
    for (const sibling of isolated) {
      const current = backgroundIsolation.get(sibling)!;
      current.count -= 1;
      if (current.count > 0) continue;
      if (!current.wasInert) sibling.removeAttribute("inert");
      backgroundIsolation.delete(sibling);
    }
  };
}

/** Keeps keyboard focus inside the active modal and returns it to its opener. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
  returnFocusRef?: RefObject<HTMLElement | null>
): void {
  const closeRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusTimer = useRef<number | null>(null);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (restoreFocusTimer.current !== null) {
      window.clearTimeout(restoreFocusTimer.current);
      restoreFocusTimer.current = null;
    }
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const ownsDialogLayer = !dialog.hasAttribute("data-dialog-layer");
    if (ownsDialogLayer) dialog.setAttribute("data-dialog-layer", "true");
    if (openerRef.current === null) openerRef.current = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusInitial = () => {
      const initial = initialFocusRef?.current ?? dialog.querySelector<HTMLElement>("[autofocus]") ?? focusableElements(dialog)[0];
      initial?.focus();
    };
    const restoreBackground = isolateBackground(dialog);
    focusInitial();
    const isTopmostDialog = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[data-dialog-layer='true']"));
      return dialogs.at(-1) === dialog;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreBackground();
      if (ownsDialogLayer) dialog.removeAttribute("data-dialog-layer");
      restoreFocusTimer.current = window.setTimeout(() => {
        restoreFocusTimer.current = null;
        if (openerRef.current?.isConnected) openerRef.current.focus();
      }, 0);
    };
  }, [dialogRef, initialFocusRef, returnFocusRef]);
}
