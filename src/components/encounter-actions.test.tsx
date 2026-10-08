/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncounterCloseDialog, EncounterOpenDialog } from "./encounter-actions";
import * as apiClient from "./api-client";

const encounter = { id: "encounter-1", patientId: "patient-1", externalId: "ATD-1", type: "OUTPATIENT" as const, status: "OPEN" as const, openedAt: "2026-10-08T12:00:00.000Z" };

describe("encounter dialogs", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("ignores a second submit while the open request is pending and closes from the backdrop", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(() => new Promise(() => undefined) as never);
    const onClose = vi.fn();
    render(<EncounterOpenDialog patientId="patient 1" onClose={onClose} onOpened={vi.fn()} />);
    const form = screen.getByRole("button", { name: "Abrir atendimento" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/patients/patient%201/encounters", expect.objectContaining({ method: "POST" }));
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when the pointer goes down inside the open dialog", () => {
    const onClose = vi.fn();
    render(<EncounterOpenDialog patientId="p" onClose={onClose} onOpened={vi.fn()} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores a second confirmation while the close request is pending and reports the result", async () => {
    let resolve!: (value: unknown) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(() => new Promise((done) => { resolve = done; }) as never);
    const onClosed = vi.fn();
    render(<EncounterCloseDialog encounter={{ ...encounter, type: "INPATIENT" }} onClose={vi.fn()} onClosed={onClosed} />);
    const confirm = screen.getByRole("button", { name: "Encerrar atendimento" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api).toHaveBeenCalledTimes(1);
    resolve({ encounter: { ...encounter, status: "CLOSED" }, pendingItems: 1 });
    await waitFor(() => expect(onClosed).toHaveBeenCalledWith({ encounter: { ...encounter, status: "CLOSED" }, pendingItems: 1 }));
  });
});
