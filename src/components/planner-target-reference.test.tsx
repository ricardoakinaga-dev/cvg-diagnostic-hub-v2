/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlannerTargetReference } from "./planner-target-reference";
let query = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => query }));
beforeEach(() => { query = new URLSearchParams("templateId=chosen"); });
afterEach(cleanup);
it("focuses only a loaded authorized reference and opens its containing disclosure", async () => {
  const selected = vi.fn(); render(<><PlannerTargetReference userId="self" parameter="templateId" prefix="checklist-" ids={["chosen"]} onTarget={selected} /><details><summary>Modelos</summary><article id="checklist-chosen" tabIndex={-1}>Modelo autorizado</article></details></>);
  await waitFor(() => expect(document.activeElement).toBe(document.getElementById("checklist-chosen")));
  expect(document.querySelector("details")).toHaveAttribute("open"); expect(selected).toHaveBeenCalledOnce();
});
it("does not focus a matching DOM id outside the authorized list or reveal its identifier", () => {
  render(<><PlannerTargetReference userId="self" parameter="templateId" prefix="checklist-" ids={[]} /><article id="checklist-chosen" tabIndex={-1}>Outro conteúdo</article></>);
  expect(document.activeElement).not.toBe(document.getElementById("checklist-chosen")); expect(screen.getByRole("status")).toHaveTextContent("não está disponível"); expect(screen.getByRole("status")).not.toHaveTextContent("chosen");
});
it("continues only existing authorized cursors, bounds automatic lookup, and never retries a failed page", async () => {
  const more = vi.fn(); const props = { userId: "self", parameter: "templateId", prefix: "checklist-", ids: [], onMore: more }; const view = render(<PlannerTargetReference {...props} nextCursor="page1" />);
  for (let index = 2; index <= 6; index++) view.rerender(<PlannerTargetReference {...props} nextCursor={`page${index}`} />);
  await waitFor(() => expect(more).toHaveBeenCalledTimes(5)); expect(screen.getByRole("button", { name: "Continuar procurando a referência" })).toBeInTheDocument();
  view.rerender(<PlannerTargetReference {...props} nextCursor="page7" error="Acesso retirado" />); expect(more).toHaveBeenCalledTimes(5); expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("initializes historical visibility once before loading more and handles a different reference on the same route", async () => {
  const requested = vi.fn(); const selected = vi.fn(); const more = vi.fn(); const props = { userId: "self", parameter: "templateId", prefix: "checklist-", ids: ["chosen", "other"], onRequested: requested, onTarget: selected, onMore: more }; const view = render(<><PlannerTargetReference {...props} /><article id="checklist-chosen" tabIndex={-1} /><article id="checklist-other" tabIndex={-1} /></>);
  expect(requested).toHaveBeenCalledTimes(1); view.rerender(<><PlannerTargetReference {...props} /><article id="checklist-chosen" tabIndex={-1} /><article id="checklist-other" tabIndex={-1} /></>); await waitFor(() => expect(selected).toHaveBeenCalledWith("chosen"));
  query = new URLSearchParams("templateId=other"); view.rerender(<><PlannerTargetReference {...props} /><article id="checklist-chosen" tabIndex={-1} /><article id="checklist-other" tabIndex={-1} /></>); expect(requested).toHaveBeenCalledTimes(2); expect(more).not.toHaveBeenCalled();
});
