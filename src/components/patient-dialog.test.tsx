/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientDialog, type CreatedPatientPayload } from "./patient-dialog";
import * as apiClient from "./api-client";

const created: CreatedPatientPayload = {
  patient: { id: "patient-amora", displayName: "Amora", species: "Canino", breed: "Labrador", sex: "Fêmea", ownerLabel: "M. Ribeiro", externalId: "CVG-AMORA", active: true },
  encounter: { id: "encounter-amora", patientId: "patient-amora", externalId: "ATD-AMORA", type: "OUTPATIENT", status: "OPEN", openedAt: "2026-08-24T12:00:00.000Z" }
};

describe("PatientDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("submits the patient and initial encounter fields", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created as never);
    const onCreated = vi.fn();
    render(<PatientDialog onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Labrador"), { target: { value: "Labrador" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "M. Ribeiro" } });
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar paciente/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(apiFetchMock).toHaveBeenCalledWith("/patients", expect.objectContaining({ method: "POST" }));
    const [, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({ displayName: "Amora", breed: "Labrador", ownerLabel: "M. Ribeiro", encounterType: "OUTPATIENT" });
  });

  it("requires ward and bed fields when inpatient is selected", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created as never);
    render(<PatientDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Bento" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Labrador"), { target: { value: "SRD" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "R. Alves" } });
    fireEvent.click(screen.getByLabelText(/Internação/));
    expect(screen.getByPlaceholderText("Ex.: UTI 1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ex.: Box 03")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex.: UTI 1"), { target: { value: "UTI 2" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Box 03"), { target: { value: "Box 07" } });
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar paciente/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({ encounterType: "INPATIENT", ward: "UTI 2", bed: "Box 07" });
  });
});
