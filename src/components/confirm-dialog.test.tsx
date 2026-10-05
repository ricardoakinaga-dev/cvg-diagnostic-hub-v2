/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConfirm, type ConfirmOptions } from "./confirm-dialog";

const options: ConfirmOptions = { title: "Revogar sessão", message: "Revogar a sessão de vet@cvg.local?", confirmLabel: "Revogar", tone: "danger" };

function Harness({ onResult }: { onResult: (value: boolean) => void }) {
  const { confirm, dialog } = useConfirm();
  return <><button type="button" onClick={() => void confirm(options).then(onResult)}>Abrir</button>{dialog}</>;
}

describe("useConfirm", () => {
  afterEach(cleanup);

  it("resolves true when confirmed and removes the dialog", async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(value) => results.push(value)} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    const dialog = await screen.findByRole("dialog", { name: "Revogar sessão" });
    expect(dialog).toHaveTextContent("vet@cvg.local");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Revogar" })); });
    await waitFor(() => expect(results).toEqual([true]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resolves false on cancel and on Escape, returning focus to the opener", async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(value) => results.push(value)} />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveFocus();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" })); });
    await waitFor(() => expect(results).toEqual([false]));
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    await screen.findByRole("dialog");
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    await waitFor(() => expect(results).toEqual([false, false]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the default tone and a custom cancel label, and tolerates a non-HTML opener", async () => {
    const results: boolean[] = [];
    function Plain() {
      const { confirm, dialog } = useConfirm();
      return <><button type="button" onClick={() => void confirm({ title: "Apagar", message: "Tem certeza?", confirmLabel: "Apagar", cancelLabel: "Voltar" }).then((value) => results.push(value))}>Abrir</button>{dialog}</>;
    }
    const { container } = render(<Plain />);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("tabindex", "0");
    container.appendChild(svg);
    (svg as unknown as HTMLElement).focus();
    expect(document.activeElement).toBe(svg);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    const dialog = await screen.findByRole("dialog", { name: "Apagar" });
    expect(within(dialog).getByRole("button", { name: "Apagar" })).toHaveClass("button-primary");
    expect(within(dialog).getByRole("button", { name: "Apagar" })).not.toHaveClass("button-danger-ghost");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Voltar" })); });
    await waitFor(() => expect(results).toEqual([false]));
  });
});
