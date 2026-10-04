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
    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Canino" } });
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: Labrador"), { target: { value: "Labrador" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "M. Ribeiro" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar cadastro de paciente/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(apiFetchMock).toHaveBeenCalledWith("/patients", expect.objectContaining({ method: "POST" }));
    const [, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({ displayName: "Amora", breed: "Labrador", ownerLabel: "M. Ribeiro", encounterType: "OUTPATIENT" });
  });

  it("requires ward and bed only when inpatient is selected", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created as never);
    render(<PatientDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Bento" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Canino" } });
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));
    expect(screen.queryByPlaceholderText("Ex.: UTI 1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Labrador"), { target: { value: "SRD" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "R. Alves" } });
    fireEvent.click(screen.getByLabelText(/Internação/));
    expect(screen.getByPlaceholderText("Ex.: UTI 1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ex.: Box 03")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ex.: UTI 1")).toBeRequired();
    expect(screen.getByPlaceholderText("Ex.: Box 03")).toBeRequired();
    fireEvent.change(screen.getByPlaceholderText("Ex.: UTI 1"), { target: { value: "UTI 2" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Box 03"), { target: { value: "Box 07" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar cadastro de paciente/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({ encounterType: "INPATIENT", ward: "UTI 2", bed: "Box 07" });
  });

  it("updates optional identity fields and closes through the backdrop", () => {
    const onClose = vi.fn();
    render(<PatientDialog onClose={onClose} onCreated={vi.fn()} nested />);
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));

    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Felino" } });
    fireEvent.change(screen.getByLabelText("Sexo"), { target: { value: "Fêmea" } });
    fireEvent.change(screen.getByLabelText("Data de nascimento"), { target: { value: "2020-01-02" } });
    fireEvent.change(screen.getByPlaceholderText("Será gerado se não for informado"), { target: { value: "his-amora" } });
    expect(screen.getByPlaceholderText("Será gerado se não for informado")).toHaveValue("HIS-AMORA");

    const backdrop = screen.getByRole("presentation");
    fireEvent.mouseDown(backdrop, { target: backdrop });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("traps focus and closes from the keyboard", async () => {
    const onClose = vi.fn();
    render(<PatientDialog onClose={onClose} onCreated={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Cadastrar paciente" });
    const firstInput = screen.getByPlaceholderText("Ex.: Amora");
    const closeButton = screen.getByRole("button", { name: "Fechar cadastro de paciente" });
    const submitButton = screen.getByRole("button", { name: /Confirmar cadastro de paciente/i });

    await waitFor(() => expect(firstInput).toHaveFocus());
    submitButton.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(submitButton).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(dialog).toBeInTheDocument();
  });

  it("creates a patient using only name, species and tutor without inventing clinical facts", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created);
    render(<PatientDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText("Espécie")).toHaveValue("");
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    for (const input of screen.getAllByRole("textbox")) expect(input).toBeRequired();
    fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: " Amora " } });
    fireEvent.change(screen.getByLabelText("Espécie"), { target: { value: " Felino " } });
    fireEvent.change(screen.getByLabelText("Tutor ou responsável"), { target: { value: " Maria " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(apiFetchMock.mock.calls[0][1]?.body as string)).toEqual({ displayName: "Amora", species: "Felino", ownerLabel: "Maria", breed: "Não informado", sex: "Não informado", encounterType: "OUTPATIENT" });
  });

  it("omits inpatient location after changing to emergency", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created);
    render(<PatientDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByLabelText("Espécie"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByLabelText("Tutor ou responsável"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));
    fireEvent.click(screen.getByLabelText(/Internação/));
    fireEvent.change(screen.getByPlaceholderText("Ex.: UTI 1"), { target: { value: "UTI" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Box 03"), { target: { value: "03" } });
    fireEvent.click(screen.getByLabelText(/Emergência/));
    expect(screen.queryByPlaceholderText("Ex.: UTI 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    const payload: Record<string, unknown> = JSON.parse(apiFetchMock.mock.calls[0][1]?.body as string);
    expect(payload.encounterType).toBe("EMERGENCY");
    expect(payload).not.toHaveProperty("ward");
    expect(payload).not.toHaveProperty("bed");
  });

  it("blocks inpatient submission without a real ward and bed", () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(created);
    render(<PatientDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByLabelText("Espécie"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByLabelText("Tutor ou responsável"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));
    fireEvent.click(screen.getByLabelText(/Internação/));
    fireEvent.click(screen.getByRole("button", { name: "Mais detalhes (opcional)" }));
    expect(screen.getByPlaceholderText("Ex.: UTI 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    expect(screen.getByPlaceholderText("Ex.: UTI 1")).toBeInvalid();
    expect(screen.getByPlaceholderText("Ex.: Box 03")).toBeInvalid();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("preserves entered values on an API failure and allows retry", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(created);
    const onCreated = vi.fn();
    render(<PatientDialog onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByLabelText("Espécie"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByLabelText("Tutor ou responsável"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível cadastrar o paciente.");
    expect(screen.getByLabelText("Nome do paciente")).toHaveValue("Amora");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
