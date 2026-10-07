/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardLayout, CalendarLayout, ListLayout, SpreadsheetLayout, type LayoutProps } from "./layouts";
import { DEFAULT_DISPLAY, groupItems, type WorkItem } from "./model";

const today = new Date(2026, 9, 6, 12);

function item(index: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `item-${index}`, requestId: `request-${index}`, requestCode: `EX-261006-${index}`,
    status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY",
    version: 1, dueAt: today.toISOString(), createdAt: today.toISOString(), overdue: false,
    patient: { id: `patient-${index}`, displayName: `Paciente ${index}`, species: "Canino", externalId: `HIS-${index}` },
    service: { id: "service-hem", code: "HEMOGRAM", name: "Hemograma" },
    ...overrides
  };
}

function calendar(items: WorkItem[]) {
  const onPeek = vi.fn();
  render(<CalendarLayout items={items} role="VIEWER" onPeek={onPeek} onMove={vi.fn()} busy={false} />);
  return { onPeek };
}

function layoutProps(items: WorkItem[], overrides: Partial<LayoutProps> = {}): LayoutProps {
  return { groups: groupItems(items, "status", true, { departments: ["LABORATORY"] }), display: DEFAULT_DISPLAY, role: "LAB_TECH", busy: false, canCreate: false, onPeek: vi.fn(), onMove: vi.fn(), onAction: vi.fn(), onCreate: vi.fn(), quickAdd: { departments: [], onCreated: vi.fn() }, ...overrides };
}

describe("work item layouts", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it.each(["month", "week"] as const)("owns all calendar headers and cells through seven-column rows in %s mode", (mode) => {
    calendar([]);
    if (mode === "week") fireEvent.click(screen.getByRole("button", { name: "Semana" }));
    const grid = screen.getByRole("grid");
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(mode === "month" ? 6 : 2);
    expect(Array.from(grid.children)).toEqual(rows);
    expect(within(rows[0]).getAllByRole("columnheader")).toHaveLength(7);
    for (const row of rows.slice(1)) {
      const cells = within(row).getAllByRole("gridcell");
      expect(cells).toHaveLength(7);
      expect(Array.from(row.children)).toEqual(cells);
    }
  });

  it.each(["month", "week"] as const)("reveals every exam in an overflowing day, including entries beyond twelve, in %s mode", (mode) => {
    const items = Array.from({ length: 13 }, (_, index) => item(index + 1));
    const { onPeek } = calendar(items);
    if (mode === "week") fireEvent.click(screen.getByRole("button", { name: "Semana" }));
    const day = screen.getByRole("gridcell", { name: `${today.toLocaleDateString("pt-BR")}: 13 exames` });
    const more = within(day).getByRole("button", { name: mode === "month" ? /^\+10 exames/ : /^\+1 exames/ });
    expect(within(day).getAllByRole("button", { name: /^Abrir / })).toHaveLength(mode === "month" ? 3 : 12);
    expect(within(day).queryByRole("button", { name: "Abrir Hemograma — Paciente 13" })).not.toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(more.getAttribute("aria-controls")!)).toBe(day.querySelector(".calendar-entries"));

    more.focus();
    fireEvent.click(more);
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(day).getAllByRole("button", { name: /^Abrir / })).toHaveLength(13);
    fireEvent.click(within(day).getByRole("button", { name: "Abrir Hemograma — Paciente 13" }));
    expect(onPeek).toHaveBeenCalledWith(items[12]);

    fireEvent.click(within(day).getByRole("button", { name: /Mostrar menos exames/ }));
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(day).getAllByRole("button", { name: /^Abrir / })).toHaveLength(mode === "month" ? 3 : 12);
  });

  it("expands only the selected calendar day", () => {
    const tomorrow = new Date(2026, 9, 7, 12);
    calendar([
      ...Array.from({ length: 4 }, (_, index) => item(index + 1)),
      ...Array.from({ length: 4 }, (_, index) => item(index + 5, { dueAt: tomorrow.toISOString() }))
    ]);
    const first = screen.getByRole("gridcell", { name: `${today.toLocaleDateString("pt-BR")}: 4 exames` });
    const second = screen.getByRole("gridcell", { name: `${tomorrow.toLocaleDateString("pt-BR")}: 4 exames` });
    fireEvent.click(within(first).getByRole("button", { name: /^\+1 exames/ }));
    expect(within(first).getAllByRole("button", { name: /^Abrir / })).toHaveLength(4);
    expect(within(second).getAllByRole("button", { name: /^Abrir / })).toHaveLength(3);
    expect(within(second).getByRole("button", { name: /^\+1 exames/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("navigates month and week periods, returns to today and skips invalid deadlines", () => {
    calendar([item(1), item(2, { dueAt: "invalid", overdue: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Próximo período" }));
    expect(screen.queryByRole("button", { name: "Abrir Hemograma — Paciente 1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Período anterior" }));
    expect(screen.getByRole("button", { name: "Abrir Hemograma — Paciente 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Semana" }));
    fireEvent.click(screen.getByRole("button", { name: "Próximo período" }));
    fireEvent.click(screen.getByRole("button", { name: "Período anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    fireEvent.click(screen.getByRole("button", { name: "Mês" }));
    expect(screen.getByRole("button", { name: "Abrir Hemograma — Paciente 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir Hemograma — Paciente 2" })).not.toBeInTheDocument();
  });

  it.each(["status", "priority", "department", "service", "patient", "none"] as const)("keeps examination context reachable when the list groups by %s", (groupBy) => {
    const entry = item(1);
    const props = layoutProps([entry], { groups: groupItems([entry], groupBy, false, { departments: ["LABORATORY"] }), display: { ...DEFAULT_DISPLAY, groupBy, properties: ["patient"] } });
    render(<ListLayout {...props} />);
    expect(screen.getByText("HIS-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Hemograma — Paciente 1" }));
    expect(props.onPeek).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("HIS-1"));
    expect(props.onPeek).toHaveBeenCalledTimes(2);
    if (groupBy !== "none") {
      const toggle = screen.getByRole("button", { expanded: true });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: "Abrir Hemograma — Paciente 1" })).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Abrir Hemograma — Paciente 1" })).toBeInTheDocument();
    }
  });

  it("moves board cards only to allowed destinations and clears cancelled drags", () => {
    const entry = item(1);
    const props = layoutProps([entry], { peekId: entry.id });
    const { rerender } = render(<BoardLayout {...props} />);
    const card = screen.getByRole("listitem");
    const requested = screen.getByRole("region", { name: "Solicitado" });
    const received = screen.getByRole("region", { name: "Amostra recebida" });
    const completed = screen.getByRole("region", { name: "Concluído" });
    const transfer = { setData: vi.fn(), effectAllowed: "" };
    expect(fireEvent.dragOver(received)).toBe(true);
    fireEvent.dragStart(card, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("text/plain", entry.id);
    expect(fireEvent.dragOver(requested)).toBe(true);
    expect(fireEvent.dragOver(completed)).toBe(true);
    expect(fireEvent.dragOver(received)).toBe(false);
    expect(received).toHaveClass("is-drop-target");
    fireEvent.dragLeave(received, { relatedTarget: card });
    expect(received).not.toHaveClass("is-drop-target");
    fireEvent.drop(received);
    expect(props.onMove).toHaveBeenCalledWith(entry, "RECEIVED");
    fireEvent.drop(received);
    expect(props.onMove).toHaveBeenCalledOnce();
    fireEvent.dragStart(card, { dataTransfer: transfer });
    fireEvent.dragEnd(card);
    expect(fireEvent.dragOver(received)).toBe(true);
    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Hemograma — Paciente 1" }));
    expect(props.onPeek).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Recolher Solicitado" }));
    fireEvent.click(screen.getByRole("button", { name: "Expandir Solicitado" }));
    rerender(<BoardLayout {...props} busy />);
    expect(screen.getByRole("listitem")).toHaveAttribute("draggable", "false");
    expect(fireEvent.dragOver(screen.getByRole("region", { name: "Amostra recebida" }))).toBe(true);
  });

  it.each(["Estado", "Prioridade", "Setor", "Prazo", "Próxima ação", "Responsável", "Solicitado em", "Protocolo"])("sorts the spreadsheet by %s without losing examination identity", (column) => {
    const late = item(2, { dueAt: new Date(2026, 9, 7, 12).toISOString(), priority: "ROUTINE", status: "REQUESTED", nextAction: "Z", overdue: true });
    const early = item(1, { priority: "EMERGENCY", status: "RECEIVED", nextAction: "A", createdAt: new Date(2026, 9, 5, 12).toISOString() });
    render(<SpreadsheetLayout items={[late, early]} role="VIEWER" onPeek={vi.fn()} onMove={vi.fn()} busy={false} peekId={early.id} />);
    const header = screen.getByRole("columnheader", { name: column });
    fireEvent.click(within(header).getByRole("button", { name: column }));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.classList.contains("is-peeked"))).toBe(true);
    if (column === "Prazo" || column === "Prioridade" || column === "Solicitado em" || column === "Próxima ação" || column === "Protocolo" || column === "Estado") expect(within(rows[0]).getByRole("button", { name: "Abrir Hemograma — Paciente 1" })).toBeInTheDocument();
  });

  it("shows an empty spreadsheet without an examination row", () => {
    render(<SpreadsheetLayout items={[]} role="VIEWER" onPeek={vi.fn()} onMove={vi.fn()} busy={false} />);
    expect(screen.getByText("Nenhum exame com os filtros atuais.")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });

  it("sorts the spreadsheet ascending, descending and back to input order while preserving item actions", () => {
    const thor = item(1, { patient: { id: "thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" } });
    const mel = item(2, { patient: { id: "mel", displayName: "Mel", species: "Felino", externalId: "HIS-MEL" } });
    const ada = item(3, { patient: { id: "ada", displayName: "Ada", species: "Canino", externalId: "HIS-ADA" } });
    const onPeek = vi.fn();
    render(<SpreadsheetLayout items={[thor, ada, mel]} role="VIEWER" onPeek={onPeek} onMove={vi.fn()} busy={false} />);
    const table = screen.getByRole("table");
    const patientHeader = within(table).getByRole("columnheader", { name: "Paciente" });
    const sort = within(patientHeader).getByRole("button", { name: "Paciente" });
    const names = () => within(table).getAllByRole("row").slice(1).map((row) => within(row).getByRole("button", { name: /^Abrir / }).getAttribute("aria-label"));

    fireEvent.click(sort);
    expect(patientHeader).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["Abrir Hemograma — Ada", "Abrir Hemograma — Mel", "Abrir Hemograma — Thor"]);
    fireEvent.click(sort);
    expect(patientHeader).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["Abrir Hemograma — Thor", "Abrir Hemograma — Mel", "Abrir Hemograma — Ada"]);
    fireEvent.click(sort);
    expect(patientHeader).not.toHaveAttribute("aria-sort");
    expect(names()).toEqual(["Abrir Hemograma — Thor", "Abrir Hemograma — Ada", "Abrir Hemograma — Mel"]);
    fireEvent.click(within(table).getByRole("button", { name: "Abrir Hemograma — Mel" }));
    expect(onPeek).toHaveBeenCalledWith(mel);
  });
});
