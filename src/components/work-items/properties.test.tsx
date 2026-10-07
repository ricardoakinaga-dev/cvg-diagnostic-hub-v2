/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextActionButtons, StatePill, WorkItemProperties, nextActions } from "./properties";
import type { WorkItem } from "./model";

const item: WorkItem = { id: "item", requestId: "req", requestCode: "EX-261006-0001", status: "RECEIVED", priority: "URGENT", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 2, dueAt: "2026-10-06T14:00:00Z", createdAt: "2026-10-06T12:00:00Z", overdue: true, currentSampleId: "sample", patient: { id: "p", displayName: "Thor", species: "Canino", externalId: "THOR" }, service: { id: "s", code: "HEM", name: "Hemograma" } };
afterEach(() => { cleanup(); });

describe("examination properties", () => {
  it("keeps keyboard menu navigation circular and dismisses on Tab or outside click", () => {
    render(<StatePill item={item} role="LAB_TECH" onMove={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /Estado:/ });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const first = screen.getAllByRole("menuitem")[0];
    fireEvent.keyDown(first, { key: "ArrowUp" });
    const last = screen.getAllByRole("menuitem").at(-1)!;
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "x" });
    fireEvent.keyDown(first, { key: "Tab" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.mouseDown(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers draft release alongside edit without exposing it to a clinician", () => {
    const draft = { ...item, status: "IN_PROGRESS" as const, currentResultId: "draft" };
    expect(nextActions(draft, "LAB_TECH")).toEqual(["RELEASE_RESULT"]);
    expect(nextActions(draft, "VETERINARIAN")).toEqual([]);
    const onAction = vi.fn();
    render(<NextActionButtons item={draft} role="LAB_TECH" onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    expect(onAction).toHaveBeenCalledWith(draft, "RELEASE_RESULT");
  });

  it("renders optional patient and next-action properties without requiring an owner", () => {
    render(<WorkItemProperties item={{ ...item, priority: "ROUTINE", overdue: false, nextAction: "Iniciar processamento" }} role="VIEWER" properties={["patient", "nextAction", "owner", "state", "priority", "department", "due"]} onMove={vi.fn()} />);
    expect(screen.getByText("Canino")).toBeInTheDocument();
    expect(screen.getByText("Iniciar processamento")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida" })).toBeDisabled();
    expect(screen.getByText("Prioridade: Rotina")).toBeInTheDocument();
    expect(screen.queryByTitle(/Responsável:/)).not.toBeInTheDocument();
  });
});
