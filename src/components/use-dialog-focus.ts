import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}

/** Keeps keyboard focus inside the active modal and returns it to its opener. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusInitial = () => {
      const initial = initialFocusRef?.current ?? dialog.querySelector<HTMLElement>("[autofocus]") ?? focusableElements(dialog)[0];
      initial?.focus();
    };
    const frame = window.requestAnimationFrame(focusInitial);
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
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.setTimeout(() => opener?.focus(), 0);
    };
  }, [dialogRef, initialFocusRef]);
}
