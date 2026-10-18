/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { HospitalCapacityView } from "@cvg/contracts";
import { HospitalCapacityPanel } from "./hospital-capacity-panel";

afterEach(cleanup);
it("explains that planned reservations do not give an actual execution end, preserving unknown minutes and known maintenance", () => {
  const data: HospitalCapacityView = { from: "2026-10-11T11:00:00Z", to: "2026-10-11T12:00:00Z", asOf: "2026-10-11T11:15:00Z", authorizedLoad: { openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 1, estimatedMinutes: null }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false }, resources: [
    { resourceId: "open", name: "Sala em execução", code: "OPEN", departmentCode: "ULTRASOUND", kind: "ROOM", unit: "MINUTES", nominal: 60, reserved: 0, available: null, unavailable: 0, availabilityKnown: false, reason: "EXECUTION_END_UNKNOWN" },
    { resourceId: "maintenance", name: "Sala em manutenção", code: "MAINT", departmentCode: "ULTRASOUND", kind: "ROOM", unit: "MINUTES", nominal: 60, reserved: 0, available: 0, unavailable: 60, availabilityKnown: true, reason: "RESOURCE_UNAVAILABLE" }
  ] };
  render(<HospitalCapacityPanel data={data} />);
  const open = screen.getByRole("rowheader", { name: /Sala em execução/ }).closest("tr")!;
  expect(open).toHaveTextContent("término da execução desconhecido");
  expect(within(open).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Minutos no período", "60 min", "0 min", "Não informada", "0 min"]);
  const maintenance = screen.getByRole("rowheader", { name: /Sala em manutenção/ }).closest("tr")!;
  expect(maintenance).not.toHaveTextContent("disponibilidade desconhecida");
  expect(within(maintenance).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Minutos no período", "60 min", "0 min", "0 min", "60 min"]);
  expect(screen.getByText(/Reservas mantêm os horários planejados/)).toHaveTextContent("não estima quando a execução termina");
  expect(screen.getByText(/SLA diagnóstico:/)).toHaveTextContent("não pausa nem recalcula");
});
