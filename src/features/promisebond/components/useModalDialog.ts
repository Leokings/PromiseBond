import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type OutsideElementState = {
  element: HTMLElement;
  hadAriaHidden: boolean;
  ariaHidden: string | null;
  inert: boolean;
};

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
}

function makeOutsideContentInert(dialog: HTMLElement) {
  const changed: OutsideElementState[] = [];
  let branch: HTMLElement = dialog;

  while (branch.parentElement && branch.parentElement !== document.body) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      changed.push({
        ariaHidden: sibling.getAttribute("aria-hidden"),
        element: sibling,
        hadAriaHidden: sibling.hasAttribute("aria-hidden"),
        inert: sibling.inert
      });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    branch = parent;
  }

  return () => {
    for (const state of changed.reverse()) {
      state.element.inert = state.inert;
      if (state.hadAriaHidden) state.element.setAttribute("aria-hidden", state.ariaHidden ?? "");
      else state.element.removeAttribute("aria-hidden");
    }
  };
}

export function useModalDialog(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !dialogRef.current) return undefined;

    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const restoreOutsideContent = makeOutsideContentInert(dialog);
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>("[autofocus]");
      const first = focusableElements(dialog)[0];
      (preferred ?? first ?? dialog).focus({ preventScroll: true });
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      restoreOutsideContent();
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [open]);

  return dialogRef;
}
