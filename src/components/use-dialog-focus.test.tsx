/** @vitest-environment jsdom */
import { createRef, StrictMode, useRef, useState, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./use-dialog-focus";

function Modal({ name, onClose, children }: { name: string; onClose: () => void; children?: React.ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, onClose);
  return <section ref={dialog} role="dialog" aria-modal="true" aria-label={name}><button onClick={onClose}>Fechar {name}</button>{children}</section>;
}

function NestedDialogs() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return <><nav aria-label="Fundo"><button onClick={() => setOpen(true)}>Abrir</button></nav>{open && <div><Modal name="principal" onClose={() => { setOpen(false); setNested(false); }}><button onClick={() => setNested(true)}>Abrir filho</button></Modal>{nested && <Modal name="filho" onClose={() => setNested(false)} />}</div>}</>;
}

function DialogWithFocusTargets({ onClose, returnFocus }: { onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const dialog = useRef<HTMLElement>(null);
  const initialFocus = useRef<HTMLInputElement>(null);
  useDialogFocus(dialog, onClose, initialFocus, returnFocus);
  return <section ref={dialog} role="dialog" aria-label="Detalhes" data-dialog-layer="true"><button>Fechar detalhes</button><input ref={initialFocus} aria-label="Observações" /></section>;
}

function DialogWithoutControls({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, onClose);
  return <section ref={dialog} role="dialog" aria-label="Aguardando dados"><p>Carregando detalhes</p><button disabled>Confirmar indisponível</button><button aria-hidden="true">Ação oculta</button></section>;
}

describe("modal background isolation", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("keeps navigation unavailable through a nested modal and restores it after both close", async () => {
    render(<NestedDialogs />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    opener.focus(); fireEvent.click(opener);
    const navigation = screen.getByRole("navigation", { name: "Fundo" });
    expect(navigation).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Abrir filho" }));
    expect(screen.getByRole("dialog", { name: "principal" })).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "filho" })).not.toBeInTheDocument();
    expect(navigation).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "principal" })).not.toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(navigation).not.toHaveAttribute("inert");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("restores background if parent and child unmount in the same commit", () => {
    const view = render(<NestedDialogs />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir filho" }));
    const navigation = screen.getByRole("navigation", { name: "Fundo" });
    view.rerender(<nav aria-label="Fundo"><button>Abrir</button></nav>);
    expect(navigation).not.toHaveAttribute("inert");
    expect(document.querySelector("[data-dialog-layer]")).toBeNull();
  });

  it("preserves background that was already inert before the dialog opened", () => {
    const background = document.createElement("aside");
    background.setAttribute("inert", "");
    document.body.append(background);
    const view = render(<Modal name="isolado" onClose={vi.fn()} />);
    expect(background).toHaveAttribute("inert");
    view.unmount();
    expect(background).toHaveAttribute("inert");
    background.remove();
  });

  it("wraps Tab at both ends, skips unavailable controls and leaves interior keys alone", () => {
    const onClose = vi.fn();
    render(<Modal name="teclado" onClose={onClose}><button aria-hidden="true">Oculto</button><input aria-label="Nome" /><button>Salvar</button><button disabled>Indisponível</button></Modal>);
    const first = screen.getByRole("button", { name: "Fechar teclado" });
    const middle = screen.getByRole("textbox", { name: "Nome" });
    const last = screen.getByRole("button", { name: "Salvar" });
    const disabled = screen.getByRole("button", { name: "Indisponível" });
    expect(first).toHaveFocus();

    expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();
    expect(last).toBeEnabled();
    expect(disabled).not.toHaveFocus();
    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
    expect(first).toHaveFocus();
    middle.focus();
    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(true);
    expect(middle).toHaveFocus();
    expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "ArrowDown" })).toBe(true);
    expect(middle).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("recaptures escaped focus on Tab without hijacking other keys", () => {
    render(<NestedDialogs />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "Fechar principal" });
    opener.focus();
    expect(opener).toHaveFocus();
    expect(fireEvent.keyDown(window, { key: "ArrowDown" })).toBe(true);
    expect(opener).toHaveFocus();
    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
    expect(first).toHaveFocus();
    opener.focus();
    expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true })).toBe(false);
    expect(first).toHaveFocus();
  });

  it("blocks Tab when no control is available but still handles Escape", () => {
    const onClose = vi.fn();
    render(<DialogWithoutControls onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Aguardando dados" }).contains(document.activeElement)).toBe(false);
    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("honors explicit initial and return focus targets and preserves an existing layer marker", async () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const returnFocus = createRef<HTMLButtonElement>();
    render(<nav aria-label="Lista"><button ref={returnFocus}>Retornar à lista</button><button>Outro atalho</button></nav>);
    screen.getByRole("button", { name: "Outro atalho" }).focus();
    const view = render(<DialogWithFocusTargets onClose={firstClose} returnFocus={returnFocus} />);
    const dialog = screen.getByRole("dialog", { name: "Detalhes" });
    const returnTarget = screen.getByRole("button", { name: "Retornar à lista" });
    const navigation = screen.getByRole("navigation", { name: "Lista" });
    expect(screen.getByRole("textbox", { name: "Observações" })).toHaveFocus();
    expect(navigation.parentElement).toHaveAttribute("inert");
    view.rerender(<DialogWithFocusTargets onClose={latestClose} returnFocus={returnFocus} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latestClose).toHaveBeenCalledOnce();
    expect(firstClose).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => expect(returnTarget).toHaveFocus());
    expect(dialog).toHaveAttribute("data-dialog-layer", "true");
    expect(navigation.parentElement).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Outro atalho" })).not.toHaveFocus();
  });

  it("keeps focus and isolation through StrictMode effect replay and restores the connected opener", async () => {
    render(<StrictMode><NestedDialogs /></StrictMode>);
    const opener = screen.getByRole("button", { name: "Abrir" });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(screen.getByRole("button", { name: "Fechar principal" })).toHaveFocus();
    expect(screen.getByRole("navigation", { name: "Fundo" })).toHaveAttribute("inert");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole("navigation", { name: "Fundo" })).not.toHaveAttribute("inert");
  });
});
