/** @vitest-environment jsdom */
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
