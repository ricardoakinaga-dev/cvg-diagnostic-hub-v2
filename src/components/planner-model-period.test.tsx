/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { normalizePlannerDisplay, normalizePlannerFilters, plannerQuery, taskMatchesFilters, PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { defaultPlannerPeriod, PlannerPeriodFields } from "./planner-period";
import { taskView } from "./planner.test-helpers";
import { usePlannerCommand } from "./planner-command";
import * as api from "./api-client";
import * as hospitalTime from "@/lib/hospital-time";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it("recovers a safe presentation from corrupt or older stored preferences without admitting extra patient columns", () => {
  for (const invalid of [null, false, [], "legacy"]) expect(normalizePlannerDisplay(invalid)).toEqual(PLANNER_DEFAULT_DISPLAY);
  expect(normalizePlannerDisplay({ layout: "GANTT", orderBy: "patientName", direction: "unsafe", groupBy: "patient", columns: ["priority", "priority", "patientId", null, "plannedEnd"] })).toEqual({ layout: "LIST", orderBy: "UPDATED", direction: "DESC", groupBy: "NONE", columns: ["title", "priority", "plannedEnd"] });
  expect(normalizePlannerDisplay({ layout: "CALENDAR", orderBy: "PLANNED_START", groupBy: "DEPARTMENT", direction: "ASC" })).toEqual({ ...PLANNER_DEFAULT_DISPLAY, layout: "CALENDAR", orderBy: "PLANNED_START", groupBy: "DEPARTMENT", direction: "ASC" });
});

it("restores only typed filters and serializes explicit false choices without identity or clinical row storage", () => {
  for (const invalid of [undefined, [], 4]) expect(normalizePlannerFilters(invalid)).toEqual({});
  expect(normalizePlannerFilters({ departmentCode: "INPATIENT", responsibleUserId: "staff-b", typeId: "type-care", planId: "plan-2", phase: "IN_PROGRESS", priority: "EMERGENCY", from: "2026-10-11T12:00:00Z", to: "bad", patientName: "private", executor: "other" })).toEqual({ departmentCode: "INPATIENT", responsibleUserId: "staff-b", typeId: "type-care", planId: "plan-2", phase: "IN_PROGRESS", priority: "EMERGENCY", from: "2026-10-11T12:00:00Z" });
  expect(normalizePlannerFilters({ departmentCode: "outside/sector", responsibleUserId: 4, typeId: "", planId: "x".repeat(101), phase: "UNSUPPORTED", priority: "CRITICAL", from: {}, to: "2026-10-12T12:00:00Z" })).toEqual({ to: "2026-10-12T12:00:00Z" });
  expect(plannerQuery({ departmentCode: "", responsibleUserId: undefined, includeDrafts: false, includeArchived: true, label: "plantão A" })).toBe("includeDrafts=false&includeArchived=true&label=plant%C3%A3o+A");
});

it("reports whether a newly created task is hidden by each explicit filter, including a plan it has not joined", () => {
  const view = taskView({ responsibleUserId: "staff-b", plannedStartAt: "2026-10-12T12:00:00Z" });
  for (const filters of [{ departmentCode: "OTHER" }, { typeId: "type-care" }, { phase: "COMPLETED" as const }, { priority: "URGENT" as const }, { responsibleUserId: "staff-a" }, { planId: "plan-1" }, { from: "2026-10-13T12:00:00Z" }, { to: "2026-10-11T12:00:00Z" }]) expect(taskMatchesFilters(view, filters)).toBe(false);
  expect(taskMatchesFilters(view, { departmentCode: "INPATIENT", typeId: view.task.typeId, phase: "PENDING", priority: "ROUTINE", responsibleUserId: "staff-b", from: "2026-10-12T12:00:00Z", to: "2026-10-12T12:00:00Z" }, " CONFERIR ")).toBe(true);
  expect(taskMatchesFilters(view, {}, "not present")).toBe(false);
  expect(taskMatchesFilters(view, {}, "hpl-1")).toBe(true);
  expect(taskMatchesFilters(taskView({ description: undefined }), { to: "2026-10-11T13:00:00Z" }, "missing patient")).toBe(false);
  expect(taskMatchesFilters(taskView(), {}, "   ")).toBe(true);
});

it("keeps a bounded seven-day default period and rejects nonexistent hospital times without changing the last valid range", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-07T15:00:00Z"));
  expect(defaultPlannerPeriod()).toEqual({ from: "2026-03-07T15:00:00.000Z", to: "2026-03-14T15:00:00.000Z" });
  vi.useRealTimers(); vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York");
  const changed = vi.fn();
  function Period() { const [value, setValue] = useState({ from: "2026-03-07T15:00:00Z", to: "2026-03-09T15:00:00Z" }); return <PlannerPeriodFields value={value} onChange={(next) => { changed(next); setValue(next); }} />; }
  render(<Period />);
  fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "" } }); expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-03-08T02:30" } }); expect(screen.getByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-03-08T03:30" } }); expect(changed).toHaveBeenLastCalledWith({ from: "2026-03-08T07:30:00.000Z", to: "2026-03-09T15:00:00Z" }); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-03-10T11:00" } }); expect(changed).toHaveBeenLastCalledWith({ from: "2026-03-08T07:30:00.000Z", to: "2026-03-10T15:00:00.000Z" });
});

it("serializes simultaneous invocations of one planner intent before React can commit its busy state", async () => {
  let resolve!: (value: unknown) => void;
  const request = vi.spyOn(api, "apiFetch").mockImplementation(() => new Promise<unknown>((done) => { resolve = done; }));
  const { result } = renderHook(() => usePlannerCommand());
  let first!: Promise<unknown>; let repeated!: Promise<unknown>;
  act(() => { first = result.current.execute("/hospital-tasks/task/commands", "POST", { command: "START", expectedVersion: 4 }); repeated = result.current.execute("/hospital-tasks/task/commands", "POST", { command: "START", expectedVersion: 4 }); });
  expect(request).toHaveBeenCalledOnce(); expect(await repeated).toBeUndefined(); expect(result.current.busy).toBe(true);
  await act(async () => { resolve({ confirmed: true }); expect(await first).toEqual({ confirmed: true }); });
  expect(result.current.busy).toBe(false); expect(result.current.error).toBe("");
});

it("retains the last confirmed period and exposes a safe message if the date converter fails unexpectedly", () => {
  const changed = vi.fn(); render(<PlannerPeriodFields value={{ from: "2026-10-11T12:00:00Z", to: "2026-10-12T12:00:00Z" }} onChange={changed} />);
  vi.spyOn(hospitalTime, "hospitalDateTimeInputToIso").mockImplementationOnce(() => { throw { privateDiagnostic: "internal conversion failure" }; });
  fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-10-11T10:00" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Informe um horário válido para o hospital."); expect(document.body.innerHTML).not.toContain("internal conversion failure"); expect(changed).not.toHaveBeenCalled();
});
