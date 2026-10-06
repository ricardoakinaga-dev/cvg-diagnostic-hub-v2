/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisplayDropdown, FiltersDropdown, Popover } from "./dropdowns";
import { DEFAULT_DISPLAY, EMPTY_FILTERS, type DisplayOptions, type WorkItemFilters } from "./model";

afterEach(cleanup);

const services = [{ code: "HEM", name: "Hemograma" }, { code: "RX", name: "RX de tórax" }];
function Filters({ initial = EMPTY_FILTERS, lockedDepartment, many = false, departments = ["LABORATORY", "RADIOLOGY"], onChange = vi.fn() }: { initial?: WorkItemFilters; lockedDepartment?: string; many?: boolean; departments?: string[]; onChange?: (next: WorkItemFilters) => void }) {
  const [filters, setFilters] = useState(initial);
  return <FiltersDropdown filters={filters} onChange={(next) => { setFilters(next); onChange(next); }} departments={departments} services={many ? Array.from({ length: 9 }, (_, i) => ({ code: `E${i}`, name: `Exame ${i}` })) : services} lockedDepartment={lockedDepartment} />;
}
function Display({ initial = DEFAULT_DISPLAY, onChange = vi.fn() }: { initial?: DisplayOptions; onChange?: (next: DisplayOptions) => void }) {
  const [display, setDisplay] = useState(initial);
  return <DisplayDropdown display={display} onChange={(next) => { setDisplay(next); onChange(next); }} />;
}

describe("Plane dropdown interactions", () => {
  it("toggles every filter dimension while retaining other selections", () => {
    const onChange = vi.fn();
    render(<Filters onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    const choices = ["Solicitado", "Urgente", "Laboratório", "Hemograma", "Somente atrasados", "Ocultar concluídos e cancelados"];
    for (const name of choices) fireEvent.click(screen.getByRole("checkbox", { name }));
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, states: ["REQUESTED"], priorities: ["URGENT"], departments: ["LABORATORY"], services: ["HEM"], overdueOnly: true, hideClosed: true });
    expect(screen.getByRole("button", { name: "Filtros 6" })).toHaveAttribute("aria-expanded", "true");
    for (const name of choices) { expect(screen.getByRole("checkbox", { name })).toBeChecked(); fireEvent.click(screen.getByRole("checkbox", { name })); }
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  });

  it("searches labels across sections and restores options when cleared", () => {
    render(<Filters />);
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    const search = screen.getByRole("textbox", { name: "Buscar filtro" });
    for (const [query, name] of [["  URGENTE  ", "Urgente"], ["labor", "Laboratório"], ["hem", "Hemograma"], ["solic", "Solicitado"]]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "Rotina" })).not.toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: "no-match" } });
    expect(screen.queryByRole("checkbox", { name: "Hemograma" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "Rotina" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Estado" }));
    expect(screen.queryByRole("checkbox", { name: "Solicitado" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Estado" }));
    expect(screen.getByRole("checkbox", { name: "Solicitado" })).toBeInTheDocument();
  });

  it("excludes the locked sector from the badge and hides sector selection", () => {
    render(<Filters initial={{ ...EMPTY_FILTERS, departments: ["LABORATORY"], overdueOnly: true }} lockedDepartment="LABORATORY" />);
    fireEvent.click(screen.getByRole("button", { name: "Filtros 1" }));
    expect(screen.queryByRole("button", { name: "Setor" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Somente atrasados" })).toBeChecked();
  });

  it("does not offer a redundant single sector or an empty exam catalog", () => {
    render(<FiltersDropdown filters={EMPTY_FILTERS} onChange={vi.fn()} departments={["LABORATORY"]} services={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    expect(screen.queryByRole("button", { name: "Setor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exame" })).not.toBeInTheDocument();
  });

  it("allows expanding a large exam catalog", () => {
    render(<Filters many />);
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    expect(screen.queryByRole("checkbox", { name: "Exame 8" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exame" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Exame 8" }));
    expect(screen.getByRole("checkbox", { name: "Exame 8" })).toBeChecked();
  });

  it("changes properties, grouping, order and empty-group visibility independently", () => {
    const onChange = vi.fn();
    render(<Display onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Exibição" }));
    fireEvent.click(screen.getByRole("button", { name: "ID" }));
    expect(screen.getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "ID" }));
    expect(screen.getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "true");
    const panel = screen.getByRole("dialog", { name: "Exibição" });
    const group = within(panel).getByRole("button", { name: "Agrupar por" }).closest("section")!;
    const order = within(panel).getByRole("button", { name: "Ordenar por" }).closest("section")!;
    fireEvent.click(within(group).getByRole("radio", { name: "Paciente" }));
    fireEvent.click(within(order).getByRole("radio", { name: "Prioridade" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Mostrar grupos vazios" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, properties: [...DEFAULT_DISPLAY.properties.filter((p) => p !== "key"), "key"], groupBy: "patient", orderBy: "priority", showEmptyGroups: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Mostrar grupos vazios" }));
    expect(screen.getByRole("checkbox", { name: "Mostrar grupos vazios" })).not.toBeChecked();
  });

  it.each(["calendar", "board"] as const)("offers only grouping options supported by %s", (layout) => {
    render(<Display initial={{ ...DEFAULT_DISPLAY, layout }} />);
    fireEvent.click(screen.getByRole("button", { name: "Exibição" }));
    expect(screen.queryByRole("radio", { name: "Nenhum" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agrupar por" }) !== null).toBe(layout === "board");
    expect(screen.queryByRole("checkbox", { name: "Mostrar grupos vazios" }) !== null).toBe(layout === "board");
    expect(screen.getByRole("button", { name: "Ordenar por" })).toBeInTheDocument();
  });

  it("keeps inside interactions open, dismisses outside and restores focus on Escape", () => {
    render(<><button>Outside</button><Popover label="Options" align="start" active><input aria-label="Inside" /></Popover></>);
    const trigger = screen.getByRole("button", { name: "Options" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Options" });
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Inside" }));
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(panel).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
